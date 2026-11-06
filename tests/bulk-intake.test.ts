import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Route handlers get the fake S3 gateway through the storage module; nothing else builds one.
const storage = vi.hoisted(() => ({
  available: true,
  binding: {
    provider: "s3" as const,
    environment: "development" as const,
    store: "fictional-bulk-s3",
  },
  gateway: undefined as unknown,
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  const unavailable = () =>
    new original.StorageConfigurationError("No fake storage.");
  return {
    ...original,
    storageConfigured: () => storage.available,
    resolveStorageBinding: () => {
      if (!storage.available) throw unavailable();
      return storage.binding;
    },
    getStorage: async () => {
      if (!storage.available) throw unavailable();
      return storage.gateway;
    },
  };
});

import { createToken } from "@/lib/api-tokens";
import { bulkItemSchema, createBulkItem } from "@/lib/bulk-intake";
import { createRecord } from "@/lib/records";
import type { Scope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import type { StorageGateway } from "@/lib/storage";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
} from "@/domain/records";
import { GET as listRoute } from "@/app/api/v1/cvs/bulk-batches/route";
import { POST as itemRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/route";
import { POST as uploadRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/upload/route";
import { POST as completeRoute } from "@/app/api/v1/cvs/uploads/[id]/complete/route";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";

// Fictional people, synthetic PDF bytes and an in-memory S3 gateway only.
function fictionalPdf(size: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  bytes.write("%PDF-1.7\nfictional bulk CV\n");
  return bytes;
}
const pdf = fictionalPdf(200);
const fakeS3: StorageGateway = {
  binding: storage.binding,
  async assertVersioning() {},
  async presignPost(key) {
    return { url: "https://example.invalid/upload", fields: { key } };
  },
  async head() {
    return {
      sizeBytes: pdf.length,
      mimeType: "application/pdf",
      version: "fictional-v1",
    };
  },
  async readRange() {
    return pdf;
  },
  async signDownload() {
    return "https://example.invalid/download";
  },
};
const file = {
  originalName: "fictional-cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: pdf.length,
};
const body = (
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  file,
  data,
  factsReviewed: true,
  duplicatesReviewed: true,
  acknowledgedDuplicateIds: [],
  ...extra,
});

describe("bulk CV intake recovery and server review evidence", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, colleague: Principal, outsider: Principal;

  /** Raw SQL through the PGlite owner, outside the runtime role and its policies. */
  async function asOwner<T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await fixture.client.exec("RESET ROLE");
    try {
      return (await fixture.client.query<T>(query, params)).rows;
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  const total = async (query: string, params: unknown[] = []) =>
    Number((await asOwner<{ n: number }>(query, params))[0].n);
  const counts = async () => ({
    candidates: await total(
      "SELECT count(*)::int AS n FROM app.records WHERE kind='candidate' AND team_id=$1",
      [owner.teamId],
    ),
    activity: await total(
      "SELECT count(*)::int AS n FROM app.activity WHERE team_id=$1",
      [owner.teamId],
    ),
    items: await total(
      "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE team_id=$1",
      [owner.teamId],
    ),
  });
  async function token(
    p: Principal,
    scopes: Scope[] = [
      "candidates:read",
      "candidates:write",
      "cvs:read",
      "cvs:write",
    ],
  ) {
    return (
      await createToken(p, {
        name: `Fictional bulk ${randomUUID().slice(0, 8)}`,
        scopes,
      })
    ).token;
  }
  const request = (url: string, bearer: string, json?: unknown) =>
    new Request(`http://localhost:3000${url}`, {
      method: json === undefined && !url.includes("/items/") ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const result = async (response: Response) => ({
    status: response.status,
    body: await response.json(),
  });
  const item = async (
    bearer: string,
    batchId: string,
    itemId: string,
    json: unknown,
  ) =>
    result(
      await itemRoute(
        request(
          `/api/v1/cvs/bulk-batches/${batchId}/items/${itemId}`,
          bearer,
          json,
        ),
        { params: Promise.resolve({ batchId, itemId }) },
      ),
    );
  const upload = async (bearer: string, batchId: string, itemId: string) =>
    result(
      await uploadRoute(
        request(
          `/api/v1/cvs/bulk-batches/${batchId}/items/${itemId}/upload`,
          bearer,
        ),
        { params: Promise.resolve({ batchId, itemId }) },
      ),
    );
  const list = async (bearer: string) =>
    result(await listRoute(request("/api/v1/cvs/bulk-batches", bearer)));
  const complete = async (bearer: string, id: string) =>
    result(
      await completeRoute(
        new Request(`http://localhost:3000/api/v1/cvs/uploads/${id}/complete`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
        }),
        { params: Promise.resolve({ id }) },
      ),
    );
  const createdEvent = async (candidateId: string) =>
    (
      await asOwner<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM app.activity WHERE record_id=$1 AND action='created'",
        [candidateId],
      )
    ).map((row) => row.metadata);

  beforeAll(async () => {
    stubLocalAuthReadiness();
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "bulk-owner",
      teamId: "bulk-team",
    });
    colleague = await seedIdentity(fixture.db, {
      userId: "bulk-colleague",
      teamId: "bulk-team",
      role: "recruiter",
    });
    outsider = await seedIdentity(fixture.db, {
      userId: "bulk-outsider",
      teamId: "bulk-other-team",
    });
    await enforceTestRls(fixture.db);
  });
  beforeEach(() => {
    storage.available = true;
    storage.gateway = fakeS3;
  });
  afterAll(async () => fixture?.close());

  it("(a) refuses an item without both review confirmations and creates nothing", async () => {
    const bearer = await token(owner);
    const before = await counts();
    for (const json of [
      body({ name: "Fictional Unreviewed" }, { factsReviewed: undefined }),
      body({ name: "Fictional Unreviewed" }, { factsReviewed: false }),
      body({ name: "Fictional Unreviewed" }, { duplicatesReviewed: false }),
      { file, data: { name: "Fictional Unreviewed" } },
    ]) {
      const response = await item(bearer, randomUUID(), randomUUID(), json);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("bulk_review_required");
    }
    expect(await counts()).toEqual(before);
  });

  it("(b) refuses unacknowledged current duplicates, then records the acknowledged review on the created event", async () => {
    const existing = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Existing",
        email: "existing.fictional@example.test",
      },
    });
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const data = {
      name: "Fictional Newcomer",
      email: "Existing.Fictional@example.test",
      skills: ["Payroll"],
    };
    const before = await counts();
    const refused = await item(bearer, batchId, itemId, body(data));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("bulk_duplicates_changed");
    expect(refused.body.error.message).toMatch(
      /check for possible duplicates again/i,
    );
    expect(await counts()).toEqual(before);

    const created = await item(
      bearer,
      batchId,
      itemId,
      body(data, { acknowledgedDuplicateIds: [existing.id] }),
    );
    expect(created.status).toBe(201);
    const candidateId = created.body.data.candidateId;
    expect(created.body.data).toMatchObject({
      id: itemId,
      batchId,
      originalName: file.originalName,
      possibleDuplicates: 1,
      uploadId: null,
      expiresAt: expect.any(String),
    });
    expect(await counts()).toMatchObject({
      candidates: before.candidates + 1,
      items: before.items + 1,
    });
    expect(await createdEvent(candidateId)).toEqual([
      {
        bulkIntake: {
          batchId,
          itemId,
          factsReviewed: true,
          duplicatesReviewed: true,
          possibleDuplicates: 1,
          limited: false,
        },
      },
    ]);
    const [record] = await asOwner<{ data: Record<string, unknown> }>(
      "SELECT data FROM app.records WHERE id=$1",
      [candidateId],
    );
    expect(record.data).toMatchObject({
      name: "Fictional Newcomer",
      reviewStatus: "Reviewed",
    });
    // The recovery row holds file metadata, the hash and the evidence; no candidate values.
    const [row] = await asOwner<Record<string, unknown>>(
      "SELECT * FROM app.bulk_intake_items WHERE id=$1",
      [itemId],
    );
    expect(Object.keys(row).sort()).toEqual(
      [
        "batch_id",
        "candidate_id",
        "created_at",
        "created_by",
        "id",
        "mime_type",
        "original_name",
        "payload_hash",
        "possible_duplicates",
        "reviewed_at",
        "size_bytes",
        "team_id",
        "updated_at",
        "upload_id",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toMatch(/Newcomer|existing\.fictional/i);
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.reviewed_at).not.toBeNull();
  });

  it("(c) replays a repeated item POST without creating a second candidate", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const json = body({ name: "Fictional Replay" });
    const before = await counts();
    const first = await item(bearer, batchId, itemId, json);
    const again = await item(bearer, batchId, itemId, json);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.data.candidateId).toBe(first.body.data.candidateId);
    expect(again.body.data).toEqual(first.body.data);
    expect((await counts()).candidates).toBe(before.candidates + 1);
  });

  it("(d) refuses the same item id with different details or file metadata", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    expect(
      (
        await item(
          bearer,
          batchId,
          itemId,
          body({ name: "Fictional Conflict" }),
        )
      ).status,
    ).toBe(201);
    const before = await counts();
    for (const json of [
      body({ name: "Fictional Conflict Changed" }),
      {
        ...body({ name: "Fictional Conflict" }),
        file: { ...file, sizeBytes: 201 },
      },
      {
        ...body({ name: "Fictional Conflict" }),
        file: { ...file, originalName: "other-fictional-cv.pdf" },
      },
    ]) {
      const response = await item(bearer, batchId, itemId, json);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("bulk_item_conflict");
    }
    expect(await counts()).toEqual(before);
  });

  it("(e) refuses an item beyond the batch limit", async () => {
    const batchId = randomUUID();
    for (let index = 0; index < BULK_INTAKE_MAX_FILES; index++)
      // Seeded through the library: one token allows 60 requests a minute.
      await createBulkItem(
        owner,
        batchId,
        randomUUID(),
        bulkItemSchema.parse(body({ name: `Fictional Batch Member ${index}` })),
      );
    const bearer = await token(owner);
    const before = await counts();
    const response = await item(
      bearer,
      batchId,
      randomUUID(),
      body({ name: "Fictional One Too Many" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bulk_batch_limit",
      message: `A batch can include up to ${BULK_INTAKE_MAX_FILES} files. Start a new import for the rest.`,
    });
    expect(await counts()).toEqual(before);
  });

  it("(f) refuses an expired batch, hides it and deletes it on the user's next import", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    expect(
      (
        await item(
          bearer,
          batchId,
          itemId,
          body({ name: "Fictional Expiring" }),
        )
      ).status,
    ).toBe(201);
    await asOwner(
      "UPDATE app.bulk_intake_batches SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=$1",
      [batchId],
    );
    const before = await counts();
    const late = await item(
      bearer,
      batchId,
      randomUUID(),
      body({ name: "Fictional Late" }),
    );
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({
      code: "bulk_batch_expired",
      message: `This import is more than ${BULK_INTAKE_RECOVERY_HOURS} hours old. Check the candidate directory before importing these CVs again.`,
    });
    const replay = await item(
      bearer,
      batchId,
      itemId,
      body({ name: "Fictional Expiring" }),
    );
    expect(replay.body.error.code).toBe("bulk_batch_expired");
    const lateUpload = await upload(bearer, batchId, itemId);
    expect(lateUpload.status).toBe(409);
    expect(lateUpload.body.error.code).toBe("bulk_batch_expired");
    expect(await counts()).toEqual(before);
    const listed = await list(bearer);
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.map((batch: { id: string }) => batch.id),
    ).not.toContain(batchId);
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE batch_id=$1",
        [batchId],
      ),
    ).toBe(1);
    expect(
      (
        await item(
          bearer,
          randomUUID(),
          randomUUID(),
          body({ name: "Fictional Next" }),
        )
      ).status,
    ).toBe(201);
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE id=$1",
        [batchId],
      ),
    ).toBe(0);
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE batch_id=$1",
        [batchId],
      ),
    ).toBe(0);
  });

  it("(g) reserves the CV once per item, reports imported after completion and pending otherwise", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID();
    // An item row without a candidate exists only by direct insert; the API never leaves one.
    const orphan = randomUUID();
    expect(
      (
        await item(
          bearer,
          batchId,
          randomUUID(),
          body({ name: "Fictional First" }),
        )
      ).status,
    ).toBe(201);
    await asOwner(
      "INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,original_name,mime_type,size_bytes,payload_hash,created_at,updated_at) VALUES($1,$2,$3,$4,'fictional-cv.pdf','application/pdf',200,$5,now(),now())",
      [orphan, owner.teamId, batchId, owner.userId, "0".repeat(64)],
    );
    const early = await upload(bearer, batchId, orphan);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("bulk_candidate_required");

    const importedId = randomUUID(),
      pendingId = randomUUID(),
      noUploadId = randomUUID();
    for (const [id, name] of [
      [importedId, "Fictional Imported"],
      [pendingId, "Fictional Pending"],
      [noUploadId, "Fictional No Upload"],
    ])
      expect((await item(bearer, batchId, id, body({ name }))).status).toBe(
        201,
      );
    const reserved = await upload(bearer, batchId, importedId);
    expect(reserved.status).toBe(201);
    expect(reserved.body.upload).toMatchObject({
      protocol: "s3-form-v1",
      method: "POST",
    });
    const repeated = await upload(bearer, batchId, importedId);
    expect(repeated.body.data.id).toBe(reserved.body.data.id);
    const done = await complete(bearer, reserved.body.data.id);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("ready");
    expect((await upload(bearer, batchId, pendingId)).status).toBe(201);

    const listed = await list(bearer);
    const batch = listed.body.data.find(
      (entry: { id: string }) => entry.id === batchId,
    );
    const outcomes = Object.fromEntries(
      batch.items.map((entry: { id: string; outcome: string }) => [
        entry.id,
        entry.outcome,
      ]),
    );
    expect(outcomes).toMatchObject({
      [orphan]: "not-imported",
      [importedId]: "imported",
      [pendingId]: "cv-pending",
      [noUploadId]: "cv-pending",
    });
    expect(Object.keys(batch.items[0]).sort()).toEqual([
      "candidateId",
      "id",
      "originalName",
      "outcome",
      "sizeBytes",
    ]);
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE upload_id=$1",
        [reserved.body.data.id],
      ),
    ).toBe(1);
  });

  it("(h) refuses with the setup message before any write when uploads are unavailable", async () => {
    storage.available = false;
    const bearer = await token(owner);
    const batchId = randomUUID();
    const before = await counts();
    const response = await item(
      bearer,
      batchId,
      randomUUID(),
      body({ name: "Fictional No Storage" }),
    );
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "STORAGE_SETUP_REQUIRED",
      message:
        "CV storage is not set up yet. Ask an administrator to finish setting it up, then try again.",
    });
    expect((await upload(bearer, batchId, randomUUID())).status).toBe(503);
    expect(await counts()).toEqual(before);
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE id=$1",
        [batchId],
      ),
    ).toBe(0);
  });

  it("(i) hides one user's batches and items from a teammate and from another team", async () => {
    const mine = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const json = body({ name: "Fictional Private Import" });
    expect((await item(mine, batchId, itemId, json)).status).toBe(201);
    for (const other of [colleague, outsider]) {
      const bearer = await token(other);
      const before = await counts();
      for (const response of [
        await item(bearer, batchId, itemId, json),
        await item(bearer, batchId, randomUUID(), json),
        await item(bearer, randomUUID(), itemId, json),
        await upload(bearer, batchId, itemId),
      ]) {
        expect(response.status, other.userId).toBe(404);
        expect(response.body.error.code).toBe("not_found");
      }
      expect(await list(bearer)).toEqual({ status: 200, body: { data: [] } });
      expect(await counts()).toEqual(before);
      expect(
        await total(
          "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE created_by=$1",
          [other.userId],
        ),
      ).toBe(0);
    }
  });

  it("(j) requires both cvs:write and candidates:write on every bulk route", async () => {
    for (const scopes of [
      ["candidates:read", "candidates:write", "cvs:read"],
      ["candidates:read", "cvs:read", "cvs:write"],
    ] as Scope[][]) {
      const bearer = await token(owner, scopes);
      const responses = [
        await item(
          bearer,
          randomUUID(),
          randomUUID(),
          body({ name: "Fictional" }),
        ),
        await upload(bearer, randomUUID(), randomUUID()),
        await list(bearer),
      ];
      for (const response of responses) expect(response.status).toBe(403);
    }
  });
});
