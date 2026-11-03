import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import {
  beginCvUpload,
  completeCvUpload,
  getCvDownload,
  listCandidateCvs,
  listCandidateCvsPage,
  parseCvListQuery,
} from "../src/lib/cvs";
import type { Principal } from "../src/lib/principal";
import type { StorageGateway } from "../src/lib/storage";

const candidate = randomUUID(),
  otherCandidate = randomUUID(),
  pdf = Buffer.from("%PDF-1.7\nfictional CV");
const p: Principal = {
  userId: "owner",
  teamId: "team",
  role: "owner",
  authType: "session",
  scopes: ["cvs:read", "cvs:write", "imports:write"],
};
const other: Principal = { ...p, userId: "other", teamId: "other-team" };
function fakeStorage(invalid = false) {
  const observed = {
    checkedVersions: [] as string[],
    downloads: [] as string[],
    latest: "validated-v1",
  };
  const gateway: StorageGateway = {
    async assertVersioning() {},
    async presignPost(key, mimeType, size, seconds) {
      expect(key).toMatch(/^teams\/team\/cvs\//);
      expect(mimeType).toBe("application/pdf");
      expect(size).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(300);
      return { url: "https://example.invalid/upload", fields: { key } };
    },
    async head() {
      return {
        sizeBytes: pdf.length,
        mimeType: "application/pdf",
        version: observed.latest,
      };
    },
    async readRange(_key, version) {
      observed.checkedVersions.push(version);
      return invalid ? Buffer.alloc(pdf.length, "x") : pdf;
    },
    async signDownload(_key, version) {
      observed.downloads.push(version);
      return "https://example.invalid/download";
    },
  };
  return { gateway, observed };
}
function metadata(extra: Record<string, unknown> = {}) {
  return {
    originalName: "fictional.pdf",
    mimeType: "application/pdf",
    sizeBytes: pdf.length,
    clientUploadId: randomUUID(),
    ...extra,
  };
}

it("rejects Blob upload before creating a reservation or contacting storage", async () => {
  const previous = process.env.CV_STORAGE_PROVIDER;
  try {
    process.env.CV_STORAGE_PROVIDER = "blob";
    await expect(beginCvUpload(p, candidate, metadata())).rejects.toMatchObject(
      {
        status: 503,
        code: "STORAGE_SETUP_REQUIRED",
        message: expect.stringMatching(/Blob CV storage is disabled/i),
      },
    );
  } finally {
    if (previous === undefined) delete process.env.CV_STORAGE_PROVIDER;
    else process.env.CV_STORAGE_PROVIDER = previous;
  }
});

describe("private CV lifecycle against PostgreSQL migrations and fake S3", () => {
  const pg = new PGlite();
  beforeAll(async () => {
    await applyMigrations(pg);
    setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES('owner','Owner','owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('team','Team','team','owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('m','team','owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified) VALUES('other','Other','other@example.test',true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('other-team','Other','other-team','other');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('om','other-team','other','owner');`);
    await pg.query(
      `INSERT INTO app.records(id,team_id,kind,data,created_by) VALUES($1,'team','candidate','{"name":"Fictional Candidate"}','owner'),($2,'other-team','candidate','{"name":"Other Fictional"}','other')`,
      [candidate, otherCandidate],
    );
  });
  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE app.activity; DELETE FROM app.uploads; DELETE FROM app.idempotency; DELETE FROM app.storage_usage;",
    );
  });
  afterAll(async () => pg.close());

  it("lists every one of 251 CV references across stable pages without counting another team", async () => {
    const ids = Array.from({ length: 251 }, () => randomUUID())
      .sort()
      .reverse();
    const sameTeamCandidate = randomUUID();
    await pg.query(
      `INSERT INTO app.records(id,team_id,kind,data,created_by) VALUES($1,'team','candidate','{"name":"Separate Fictional Candidate"}','owner')`,
      [sameTeamCandidate],
    );
    for (const [id, teamId, candidateId, actor] of [
      ...ids.map((id) => [id, "team", candidate, "owner"]),
      [randomUUID(), "other-team", otherCandidate, "other"],
      [randomUUID(), "team", sameTeamCandidate, "owner"],
    ]) {
      await pg.query(
        `INSERT INTO app.uploads(id,team_id,candidate_id,original_name,mime_type,size_bytes,status,object_key,created_by,created_at,expires_at) VALUES($1,$2,$3,'fictional.pdf','application/pdf',10,'rejected','fictional-key',$4,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`,
        [id, teamId, candidateId, actor],
      );
    }
    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        listCandidateCvsPage(p, candidate, { page, pageSize: 100 }),
      ),
    );
    expect(pages.map((page) => page.data.length)).toEqual([100, 100, 51]);
    expect(pages[0].pagination).toEqual({
      page: 1,
      pageSize: 100,
      total: 251,
      totalPages: 3,
    });
    expect(pages.flatMap((page) => page.data.map((cv) => cv.id))).toEqual(ids);
    expect(
      (await listCandidateCvsPage(p, candidate, { page: 4, pageSize: 100 }))
        .pagination.total,
    ).toBe(251);
    expect(
      (await listCandidateCvsPage(p, candidate, { page: 4, pageSize: 100 }))
        .data,
    ).toEqual([]);
    await expect(
      listCandidateCvsPage(other, candidate, { page: 1, pageSize: 100 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects malformed, repeated, excessive or unsupported CV pagination inputs", async () => {
    expect(parseCvListQuery(new URLSearchParams())).toEqual({
      page: 1,
      pageSize: 30,
    });
    expect(
      parseCvListQuery(new URLSearchParams("page=3&pageSize=100")),
    ).toEqual({ page: 3, pageSize: 100 });
    for (const query of [
      "page=0",
      "page=-1",
      "page=1.5",
      "page=1e2",
      "page=01",
      "page=",
      "page=1&page=2",
      "pageSize=101",
      "pageSize=0",
      "pageSize=10.0",
      "unknown=true",
    ]) {
      expect(() => parseCvListQuery(new URLSearchParams(query))).toThrow();
    }
    await expect(
      listCandidateCvsPage(p, candidate, { page: 1, pageSize: 101 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reserves once for retry-safe initialization and rejects conflicting metadata", async () => {
    const { gateway } = fakeStorage(),
      input = metadata();
    const first = await beginCvUpload(p, candidate, input, gateway),
      second = await beginCvUpload(p, candidate, input, gateway);
    expect(second.data.id).toBe(first.data.id);
    expect(
      (
        await pg.query(
          "SELECT reserved_bytes::int, reserved_files FROM app.storage_usage",
        )
      ).rows,
    ).toEqual([{ reserved_bytes: pdf.length, reserved_files: 1 }]);
    await expect(
      beginCvUpload(
        p,
        candidate,
        { ...input, sizeBytes: pdf.length + 1 },
        gateway,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("records a validated version once and always downloads that version after a replay", async () => {
    const { gateway, observed } = fakeStorage(),
      ticket = await beginCvUpload(p, candidate, metadata(), gateway);
    await completeCvUpload(p, ticket.data.id, gateway);
    observed.latest = "replayed-v2";
    await completeCvUpload(p, ticket.data.id, gateway);
    await getCvDownload(p, ticket.data.id, gateway);
    expect(observed.checkedVersions).toEqual(["validated-v1"]);
    expect(observed.downloads).toEqual(["validated-v1"]);
    expect(
      (
        await pg.query(
          "SELECT used_bytes::int,reserved_bytes::int,used_files,reserved_files FROM app.storage_usage",
        )
      ).rows,
    ).toEqual([
      {
        used_bytes: pdf.length,
        reserved_bytes: 0,
        used_files: 1,
        reserved_files: 0,
      },
    ]);
    expect(
      (
        await pg.query(
          "SELECT action FROM app.activity WHERE action='cv.uploaded'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rejects spoofed documents and releases pending reservations atomically", async () => {
    const { gateway } = fakeStorage(true),
      ticket = await beginCvUpload(p, candidate, metadata(), gateway);
    await expect(
      completeCvUpload(p, ticket.data.id, gateway),
    ).rejects.toMatchObject({ status: 400 });
    expect((await listCandidateCvs(p, candidate))[0].status).toBe("rejected");
    expect(
      (
        await pg.query(
          "SELECT used_files,reserved_files FROM app.storage_usage",
        )
      ).rows,
    ).toEqual([{ used_files: 0, reserved_files: 0 }]);
  });
  it("does not expose or sign another team’s candidate or upload identifiers", async () => {
    const { gateway, observed } = fakeStorage(),
      ticket = await beginCvUpload(p, candidate, metadata(), gateway);
    await expect(listCandidateCvs(other, candidate)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      beginCvUpload(p, otherCandidate, metadata(), gateway),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      completeCvUpload(other, ticket.data.id, gateway),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getCvDownload(other, ticket.data.id, gateway),
    ).rejects.toMatchObject({ status: 404 });
    expect(observed.checkedVersions).toEqual([]);
    expect(observed.downloads).toEqual([]);
  });
  it("counts pending quota and commits expiry cleanup even when the next reservation fails", async () => {
    const { gateway } = fakeStorage(),
      first = await beginCvUpload(p, candidate, metadata(), gateway);
    await pg.query("UPDATE app.storage_usage SET max_bytes=$1,max_files=1", [
      pdf.length,
    ]);
    await expect(
      beginCvUpload(p, candidate, metadata(), gateway),
    ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
    await pg.query(
      "UPDATE app.uploads SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [first.data.id],
    );
    await expect(
      beginCvUpload(
        p,
        candidate,
        metadata({ sizeBytes: pdf.length + 1 }),
        gateway,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
    expect(
      (
        await pg.query(
          "SELECT reserved_bytes::int,reserved_files FROM app.storage_usage",
        )
      ).rows,
    ).toEqual([{ reserved_bytes: 0, reserved_files: 0 }]);
    expect((await listCandidateCvs(p, candidate))[0].status).toBe("rejected");
  });
  it("reuses a verified ready legacy source without creating or reserving another file", async () => {
    const { gateway } = fakeStorage(),
      input = metadata({
        legacySourceId: "legacy-file-1",
        sourcePath: "Engineering/fictional.pdf",
      });
    const first = await beginCvUpload(p, candidate, input, gateway);
    await completeCvUpload(p, first.data.id, gateway);
    const retry = await beginCvUpload(
      p,
      candidate,
      { ...input, clientUploadId: randomUUID() },
      gateway,
    );
    expect(retry.data.id).toBe(first.data.id);
    expect(retry.upload).toBeNull();
    expect(
      (await pg.query("SELECT count(*)::int AS count FROM app.uploads")).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("serializes simultaneous reservations so a one-file quota cannot be exceeded", async () => {
    const { gateway } = fakeStorage();
    await pg.exec(
      "INSERT INTO app.storage_usage(team_id,max_files) VALUES('team',1)",
    );
    const results = await Promise.allSettled([
      beginCvUpload(p, candidate, metadata(), gateway),
      beginCvUpload(p, candidate, metadata(), gateway),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (await pg.query("SELECT reserved_files FROM app.storage_usage")).rows,
    ).toEqual([{ reserved_files: 1 }]);
  });
});
