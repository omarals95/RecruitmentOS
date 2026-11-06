import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { hashPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import { account } from "../src/db/auth-schema";
import { assertStorageSchema } from "../src/db/storage-schema";
import {
  authenticateApiToken,
  createToken,
  revokeToken,
} from "../src/lib/api-tokens";
import { beginCvUpload, completeCvUpload, getCvDownload } from "../src/lib/cvs";
import type { Principal } from "../src/lib/principal";
import {
  bootstrapTeam,
  createRecord,
  getCandidateState,
  getRecord,
  updateCandidateState,
} from "../src/lib/records";
import type { StorageGateway } from "../src/lib/storage";
import { installTenantContextKey } from "../src/lib/tenant-context";
import {
  authCaller,
  createTestAuth,
  PASSWORD,
  type Mail,
} from "./helpers/auth";
import { seedIdentity } from "./helpers/db";
import { CLIENT_IP, stubLocalAuthReadiness } from "./helpers/readiness";

// A local stand-in for a database backup: dumpDataDir copies the whole fictional PGlite cluster and
// loadDataDir opens the copy as a separate database. It proves what a restore carries over, not Neon
// point-in-time recovery, Blob object backup or restore timing.
const pdf = Buffer.from("%PDF-1.7\nfictional restore CV");
const note = "Fictional private restore note";
/** CV objects in memory; a restore copies only the database, so the objects stay where they are. */
const objects = new Map<string, Buffer>();
const signed: string[] = [];
const gateway: StorageGateway = {
  binding: {
    provider: "s3",
    environment: "development",
    store: "fictional-restore",
  },
  async assertVersioning() {},
  async presignPost(key) {
    // The fictional client upload this ticket stands for.
    objects.set(key, pdf);
    return { url: "https://example.invalid/upload", fields: { key } };
  },
  async head(key) {
    return {
      sizeBytes: objects.get(key)!.length,
      mimeType: "application/pdf",
      version: "fictional-v1",
    };
  },
  async readRange(key) {
    return objects.get(key)!;
  },
  async signDownload(key) {
    signed.push(key);
    return "https://example.invalid/download";
  },
};
/** Raw rows a restore must carry over unchanged, read as the PGlite superuser. */
const tables = [
  "SELECT name, applied_at FROM public.recruitment_migrations ORDER BY name",
  "SELECT id, team_id, kind, data, version, candidate_id, vacancy_id, application_id, private_owner_id FROM app.records ORDER BY id",
  "SELECT * FROM app.activity ORDER BY id",
  "SELECT * FROM app.candidate_states ORDER BY candidate_id, user_id",
  "SELECT * FROM app.uploads ORDER BY id",
  "SELECT id, token_hash, revoked_at FROM auth.api_tokens ORDER BY id",
  "SELECT id, token, user_id FROM auth.session ORDER BY id",
];
const snapshot = async (pg: PGlite) =>
  Promise.all(tables.map(async (text) => (await pg.query(text)).rows));

describe("PGlite dump and restore rehearsal", () => {
  const source = new PGlite();
  let restored: PGlite;
  let early: PGlite;
  let ownerA: Principal, memberA: Principal, ownerB: Principal;
  let candidateId: string, offerId: string, applicationId: string;
  let vacancyId: string, cvId: string, cvKey: string;
  let activeToken: string, revokedToken: string;
  let keptCookie: string, revokedCookie: string;
  let atBackup: Awaited<ReturnType<typeof snapshot>>;
  const mail: Mail[] = [];
  const open = (pg: PGlite) => drizzle(pg, { schema }) as unknown as AppDb;

  beforeAll(async () => {
    stubLocalAuthReadiness();
    await applyMigrations(source);
    await installTenantContextKey(source);
    const db = open(source);
    setDbForTests(db);
    ownerA = await seedIdentity(db, {
      userId: "restore-owner-a",
      teamId: "restore-team-a",
    });
    memberA = await seedIdentity(db, {
      userId: "restore-member-a",
      teamId: "restore-team-a",
      role: "recruiter",
    });
    ownerB = await seedIdentity(db, {
      userId: "restore-owner-b",
      teamId: "restore-team-b",
    });
    await bootstrapTeam(ownerA);
    candidateId = (
      await createRecord(ownerA, "candidates", {
        data: {
          name: "Fictional Restore Candidate",
          email: "restore-candidate@example.test",
          reviewStatus: "Needs review",
        },
      })
    ).id;
    vacancyId = (
      await createRecord(ownerA, "vacancies", {
        data: {
          title: "Fictional Analyst",
          requisitionId: "RESTORE-001",
          status: "Open",
          openings: 1,
        },
      })
    ).id;
    applicationId = (
      await createRecord(ownerA, "applications", {
        candidateId,
        vacancyId,
        data: { stage: "Offer", source: "Fictional restore rehearsal" },
      })
    ).id;
    offerId = (
      await createRecord(ownerA, "offers", {
        applicationId,
        data: {
          title: "Fictional offer",
          amount: "32000.75",
          currency: "AED",
          status: "Draft",
        },
      })
    ).id;
    await updateCandidateState(memberA, candidateId, {
      version: 0,
      status: "Contacted",
      note,
    });
    const ticket = await beginCvUpload(
      ownerA,
      candidateId,
      {
        originalName: "fictional-restore.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        clientUploadId: randomUUID(),
      },
      gateway,
    );
    cvId = (await completeCvUpload(ownerA, ticket.data.id, gateway)).id;
    cvKey = [...objects.keys()][0];
    activeToken = (
      await createToken(ownerA, {
        name: "Fictional kept token",
        scopes: ["candidates:read"],
      })
    ).token;
    const revoked = await createToken(ownerA, {
      name: "Fictional revoked token",
      scopes: ["candidates:read"],
    });
    revokedToken = revoked.token;
    await db.insert(account).values({
      id: randomUUID(),
      accountId: ownerA.userId,
      providerId: "credential",
      userId: ownerA.userId,
      password: await hashPassword(PASSWORD),
    });
    const caller = authCaller(createTestAuth(db, mail));
    keptCookie = await caller.signIn(`${ownerA.userId}@example.test`);
    revokedCookie = await caller.signIn(`${ownerA.userId}@example.test`);
    // A backup taken before the revocations below.
    const beforeRevocation = await source.dumpDataDir();
    await revokeToken(ownerA, revoked.data.id);
    expect(
      (await caller.post("sign-out", {}, { cookie: revokedCookie })).status,
    ).toBe(200);
    atBackup = await snapshot(source);
    const backup = await source.dumpDataDir();
    restored = new PGlite({ loadDataDir: backup });
    early = new PGlite({ loadDataDir: beforeRevocation });
    setDbForTests(open(restored));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([source.close(), restored?.close(), early?.close()]);
  });

  it("restores the migration ledger and every audited table exactly and passes the storage schema check", async () => {
    expect(await snapshot(restored)).toEqual(atBackup);
    expect(atBackup[0].length).toBeGreaterThan(0);
    await expect(assertStorageSchema(restored)).resolves.toBeUndefined();
  });

  it("restores relationships, the offer amount, activity and private state", async () => {
    const [, records, activity, states] = atBackup;
    expect(records.length).toBeGreaterThan(4);
    expect(activity.length).toBeGreaterThan(4);
    expect(states).toHaveLength(1);
    expect(
      await getRecord(ownerA, "applications", applicationId),
    ).toMatchObject({ candidateId, vacancyId });
    const offer = await getRecord(ownerA, "offers", offerId);
    expect(offer.applicationId).toBe(applicationId);
    expect(offer.data).toMatchObject({ amount: "32000.75", currency: "AED" });
    expect(await getCandidateState(memberA, candidateId)).toMatchObject({
      status: "Contacted",
      note,
    });
  });

  it("keeps team and private boundaries after the restore", async () => {
    await expect(
      getRecord(ownerB, "candidates", candidateId),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await getCandidateState(ownerA, candidateId)).toMatchObject({
      status: "New",
      note: "",
      version: 0,
    });
  });

  it("resolves the same CV object, whose bytes are unchanged", async () => {
    signed.length = 0;
    expect((await getCvDownload(ownerA, cvId, gateway)).url).toBe(
      "https://example.invalid/download",
    );
    expect(signed).toEqual([cvKey]);
    expect(objects.get(cvKey)!.equals(pdf)).toBe(true);
  });

  it("keeps a token and session revoked before the backup revoked", async () => {
    expect((await authenticateApiToken(activeToken, CLIENT_IP)).userId).toBe(
      ownerA.userId,
    );
    await expect(
      authenticateApiToken(revokedToken, CLIENT_IP),
    ).rejects.toMatchObject({ status: 401 });
    const caller = authCaller(createTestAuth(open(restored), mail));
    expect(await caller.session(keptCookie)).not.toBeNull();
    expect(await caller.session(revokedCookie)).toBeNull();
  });

  it("a restore from before a revocation brings the revoked token and session back: the documented reason for the post-restore owner decision", async () => {
    // Documented hazard (docs/recovery-runbook.md): a restore to a point before a revocation undoes it.
    setDbForTests(open(early));
    expect((await authenticateApiToken(revokedToken, CLIENT_IP)).userId).toBe(
      ownerA.userId,
    );
    const caller = authCaller(createTestAuth(open(early), mail));
    expect(await caller.session(revokedCookie)).not.toBeNull();
  });
});
