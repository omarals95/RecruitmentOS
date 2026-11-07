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
import { GET as batchRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/route";
import { POST as itemRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/route";
import { POST as uploadRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/upload/route";
import { POST as completeRoute } from "@/app/api/v1/cvs/uploads/[id]/complete/route";
import { withTeam } from "@/lib/db-team";
import { sql } from "drizzle-orm";
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
  let owner: Principal,
    colleague: Principal,
    outsider: Principal,
    third: Principal,
    pager: Principal;

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
  const list = async (bearer: string, query = "") =>
    result(
      await listRoute(request(`/api/v1/cvs/bulk-batches${query}`, bearer)),
    );
  const batch = async (bearer: string, batchId: string) =>
    result(
      await batchRoute(request(`/api/v1/cvs/bulk-batches/${batchId}`, bearer), {
        params: Promise.resolve({ batchId }),
      }),
    );
  /** A batch with one item, written by the owner connection; expired when hoursLeft is negative. */
  const insertBatch = async (
    who: Principal,
    hoursLeft: number,
    createdMinutesAgo = 180,
  ) => {
    const id = randomUUID();
    await asOwner(
      "INSERT INTO app.bulk_intake_batches(id,team_id,created_by,created_at,expires_at) VALUES($1,$2,$3,now()-make_interval(mins=>$4),now()+make_interval(hours=>$5))",
      [id, who.teamId, who.userId, createdMinutesAgo, hoursLeft],
    );
    await asOwner(
      "INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,original_name,mime_type,size_bytes,payload_hash,created_at,updated_at) VALUES($1,$2,$3,$4,'fictional-cv.pdf','application/pdf',200,$5,now(),now())",
      [randomUUID(), who.teamId, id, who.userId, "0".repeat(64)],
    );
    return id;
  };
  /** The batch row plus its item rows. */
  const batchRows = async (id: string) =>
    (await total(
      "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE id=$1",
      [id],
    )) +
    (await total(
      "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE batch_id=$1",
      [id],
    ));
  /** Whether the batch row is a purge tombstone, and how many item rows it still has. */
  const tombstone = async (id: string) => {
    const [row] = await asOwner<{ purged_at: Date | null }>(
      "SELECT purged_at FROM app.bulk_intake_batches WHERE id=$1",
      [id],
    );
    return {
      purged: row.purged_at !== null,
      items: await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE batch_id=$1",
        [id],
      ),
    };
  };
  const expiredError = {
    code: "bulk_batch_expired",
    message: `This import is more than ${BULK_INTAKE_RECOVERY_HOURS} hours old. Check the candidate directory before importing these CVs again.`,
  };
  const uploadsOf = (candidateId: string) =>
    total("SELECT count(*)::int AS n FROM app.uploads WHERE candidate_id=$1", [
      candidateId,
    ]);
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
    third = await seedIdentity(fixture.db, {
      userId: "bulk-third",
      teamId: "bulk-team",
      role: "recruiter",
    });
    pager = await seedIdentity(fixture.db, {
      userId: "bulk-pager",
      teamId: "bulk-team",
      role: "recruiter",
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
        "erased_at",
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
        "upload_key",
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
      message:
        "A batch can include up to 200 files. Start a new import for the rest.",
    });
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE batch_id=$1",
        [batchId],
      ),
    ).toBe(200);
    expect(await counts()).toEqual(before);
  });

  it("(f) refuses an expired batch, then a list GET hides it, deletes its items and keeps a tombstone", async () => {
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
    // An item POST purges other expired batches but keeps the requested one to refuse it.
    expect(await batchRows(batchId)).toBe(2);
    const lateUpload = await upload(bearer, batchId, itemId);
    expect(lateUpload.status).toBe(409);
    expect(lateUpload.body.error.code).toBe("bulk_batch_expired");
    expect(await counts()).toEqual(before);
    expect(await batchRows(batchId)).toBe(2);
    expect(await tombstone(batchId)).toEqual({ purged: false, items: 1 });
    const listed = await list(bearer);
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.map((entry: { id: string }) => entry.id),
    ).not.toContain(batchId);
    expect(await tombstone(batchId)).toEqual({ purged: true, items: 0 });
    // The tombstone keeps IDs and timestamps only: no file metadata, hashes or candidate values.
    const [row] = await asOwner<Record<string, unknown>>(
      "SELECT * FROM app.bulk_intake_batches WHERE id=$1",
      [batchId],
    );
    expect(Object.keys(row).sort()).toEqual([
      "created_at",
      "created_by",
      "expires_at",
      "id",
      "purged_at",
      "team_id",
    ]);
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
      expect(await list(bearer)).toEqual({
        status: 200,
        body: {
          data: [],
          pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
        },
      });
      expect((await batch(bearer, batchId)).status).toBe(404);
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
        await batch(bearer, randomUUID()),
      ];
      for (const response of responses) expect(response.status).toBe(403);
    }
  });

  it("(k) purges expired batches of every user and team on a list GET to tombstones and keeps unexpired ones", async () => {
    const expired = [
      await insertBatch(colleague, -1),
      await insertBatch(outsider, -1),
    ];
    const live = [
      await insertBatch(colleague, 1),
      await insertBatch(outsider, 1),
    ];
    for (const id of [...expired, ...live]) expect(await batchRows(id)).toBe(2);
    const listed = await list(await token(third));
    expect(listed.status).toBe(200);
    expect(listed.body.pagination.total).toBe(0);
    for (const id of expired)
      expect(await tombstone(id)).toEqual({ purged: true, items: 0 });
    for (const id of live)
      expect(await tombstone(id)).toEqual({ purged: false, items: 1 });
  });

  it("(l) purges at most 100 expired batches per request, oldest expiry first", async () => {
    const expiredCount = () =>
      total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE expires_at <= now() AND purged_at IS NULL",
      );
    expect(await expiredCount()).toBe(0);
    await asOwner(
      "INSERT INTO app.bulk_intake_batches(id,team_id,created_by,created_at,expires_at) SELECT gen_random_uuid(),$1,$2,now()-interval '2 days',now()-make_interval(mins=>n) FROM generate_series(1,101) n",
      [colleague.teamId, colleague.userId],
    );
    expect(await expiredCount()).toBe(101);
    expect((await list(await token(owner))).status).toBe(200);
    expect(await expiredCount()).toBe(1);
    // The batch that expired most recently is the one left.
    expect(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE expires_at <= now() AND expires_at > now()-interval '90 seconds' AND purged_at IS NULL",
      ),
    ).toBe(1);
    expect((await list(await token(owner))).status).toBe(200);
    expect(await expiredCount()).toBe(0);
  });

  it("(m) runs the purge helper only inside a verified context with cvs:write", async () => {
    await expect(
      fixture.client.query("SELECT tenant_context.purge_bulk_intake(NULL)"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTeam({ ...owner, scopes: ["candidates:read"] }, (tx) =>
        tx.execute(sql`select tenant_context.purge_bulk_intake(null::uuid)`),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("(n) pages the caller's unexpired batches newest first and refuses other query keys", async () => {
    const bearer = await token(pager);
    const ids: string[] = [];
    // Created one minute apart; index 0 is the oldest.
    for (let index = 0; index < 12; index++)
      ids.push(await insertBatch(pager, 1, 120 - index));
    const newestFirst = [...ids].reverse();
    await insertBatch(pager, -1);
    await insertBatch(third, 1);
    const first = await list(bearer);
    expect(first.status).toBe(200);
    expect(first.body.pagination).toEqual({
      page: 1,
      pageSize: 10,
      total: 12,
      totalPages: 2,
    });
    expect(first.body.data.map((entry: { id: string }) => entry.id)).toEqual(
      newestFirst.slice(0, 10),
    );
    expect(Object.keys(first.body.data[0]).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "items",
    ]);
    expect(first.body.data[0].items).toHaveLength(1);
    const second = await list(bearer, "?page=2");
    expect(second.body.data.map((entry: { id: string }) => entry.id)).toEqual(
      newestFirst.slice(10),
    );
    expect(second.body.pagination).toMatchObject({ page: 2, total: 12 });
    const wide = await list(bearer, "?pageSize=20");
    expect(wide.body.data).toHaveLength(12);
    expect(wide.body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 12,
      totalPages: 1,
    });
    for (const query of [
      "?pageSize=21",
      "?page=0",
      "?page=abc",
      "?page=1&page=2",
      "?other=1",
      "?page=01",
      "?page=1000001",
    ]) {
      const refused = await list(bearer, query);
      expect(refused.status, query).toBe(400);
      expect(refused.body.error.code, query).toBe("invalid_query");
    }
  });

  it("(o) reads one own unexpired batch in the list-entry shape and 404s every other ID", async () => {
    const mine = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    expect(
      (await item(mine, batchId, itemId, body({ name: "Fictional Single" })))
        .status,
    ).toBe(201);
    const read = await batch(mine, batchId);
    expect(read.status).toBe(200);
    const listed = await list(mine, "?pageSize=20");
    expect(read.body).toEqual({
      data: listed.body.data.find(
        (entry: { id: string }) => entry.id === batchId,
      ),
    });
    expect(read.body.data.items).toEqual([
      {
        id: itemId,
        originalName: file.originalName,
        sizeBytes: file.sizeBytes,
        candidateId: expect.any(String),
        outcome: "cv-pending",
      },
    ]);
    const expired = await insertBatch(owner, -1);
    for (const id of [
      await insertBatch(colleague, 1),
      await insertBatch(outsider, 1),
      randomUUID(),
      expired,
      "not-a-uuid",
    ]) {
      const response = await batch(mine, id);
      expect(response.status, id).toBe(404);
      expect(response.body.error.code).toBe("not_found");
    }
    // The single-batch GET does not purge.
    expect(await batchRows(expired)).toBe(2);
  });

  it("(p) starts a new attempt under a new key after the S3 reservation expired", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const created = await item(
      bearer,
      batchId,
      itemId,
      body({ name: "Fictional Expired Reservation" }),
    );
    const candidateId = created.body.data.candidateId;
    const first = await upload(bearer, batchId, itemId);
    expect(first.status).toBe(201);
    const oldId = first.body.data.id;
    await asOwner(
      "UPDATE app.uploads SET created_at=now()-interval '2 hours', expires_at=now()-interval '1 minute' WHERE id=$1",
      [oldId],
    );
    const fresh = await upload(bearer, batchId, itemId);
    expect(fresh.status).toBe(201);
    expect(fresh.body.upload).toMatchObject({ protocol: "s3-form-v1" });
    const newId = fresh.body.data.id;
    expect(newId).not.toBe(oldId);
    const [old] = await asOwner<{ status: string }>(
      "SELECT status FROM app.uploads WHERE id=$1",
      [oldId],
    );
    expect(old.status).toBe("rejected");
    const again = await upload(bearer, batchId, itemId);
    expect(again.body.data.id).toBe(newId);
    expect(await uploadsOf(candidateId)).toBe(2);
    const [row] = await asOwner<{ upload_id: string; upload_key: string }>(
      "SELECT upload_id, upload_key FROM app.bulk_intake_items WHERE id=$1",
      [itemId],
    );
    expect(row.upload_id).toBe(newId);
    expect(row.upload_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.upload_key).not.toBe(itemId);
  });

  it("(q) returns a live or ready attempt again without a new reservation", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const created = await item(
      bearer,
      batchId,
      itemId,
      body({ name: "Fictional Live Attempt" }),
    );
    const candidateId = created.body.data.candidateId;
    const first = await upload(bearer, batchId, itemId);
    expect(await uploadsOf(candidateId)).toBe(1);
    const pending = await upload(bearer, batchId, itemId);
    expect(pending.status).toBe(201);
    expect(pending.body.data.id).toBe(first.body.data.id);
    expect(await uploadsOf(candidateId)).toBe(1);
    expect((await complete(bearer, first.body.data.id)).body.data.status).toBe(
      "ready",
    );
    const ready = await upload(bearer, batchId, itemId);
    expect(ready.body.data.id).toBe(first.body.data.id);
    expect(ready.body.upload).toBeNull();
    expect(await uploadsOf(candidateId)).toBe(1);
    const [row] = await asOwner<{ upload_key: string | null }>(
      "SELECT upload_key FROM app.bulk_intake_items WHERE id=$1",
      [itemId],
    );
    expect(row.upload_key).toBeNull();
  });

  it("(r) refuses a late retry for any client after another team's list GET purged the batch, and never recreates it", async () => {
    const bearer = await token(owner),
      other = await token(colleague);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const json = body({ name: "Fictional Late Retry" });
    expect((await item(bearer, batchId, itemId, json)).status).toBe(201);
    await asOwner(
      "UPDATE app.bulk_intake_batches SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=$1",
      [batchId],
    );
    const expiry = async () =>
      (
        await asOwner<{ expires_at: Date }>(
          "SELECT expires_at FROM app.bulk_intake_batches WHERE id=$1",
          [batchId],
        )
      )[0].expires_at.toISOString();
    const expiresAt = await expiry();
    expect((await list(await token(outsider))).status).toBe(200);
    expect(await tombstone(batchId)).toEqual({ purged: true, items: 0 });
    const before = await counts();
    for (const response of [
      await item(bearer, batchId, itemId, json),
      await item(
        bearer,
        batchId,
        randomUUID(),
        body({ name: "Fictional New" }),
      ),
      await upload(bearer, batchId, itemId),
    ]) {
      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject(expiredError);
    }
    expect(await counts()).toEqual(before);
    expect(await tombstone(batchId)).toEqual({ purged: true, items: 0 });
    expect(await expiry()).toBe(expiresAt);
    const listed = await list(bearer, "?pageSize=20");
    expect(
      listed.body.data.map((entry: { id: string }) => entry.id),
    ).not.toContain(batchId);
    expect(listed.body.pagination.total).toBe(
      await total(
        "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE created_by=$1 AND expires_at > now() AND purged_at IS NULL",
        [owner.userId],
      ),
    );
    expect((await batch(bearer, batchId)).status).toBe(404);
    for (const response of [
      await item(other, batchId, itemId, json),
      await item(other, batchId, randomUUID(), json),
      await upload(other, batchId, itemId),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_found");
    }
    expect(await counts()).toEqual(before);
  });

  it("(s) refuses an item POST after a concurrent purge from another team tombstoned the batch", async () => {
    const bearer = await token(owner);
    const batchId = await insertBatch(owner, -1);
    // Stands in for another team's purge between the item POST's own purge step and its insert.
    await withTeam(outsider, (tx) =>
      tx.execute(sql`select tenant_context.purge_bulk_intake(null::uuid)`),
    );
    expect(await tombstone(batchId)).toEqual({ purged: true, items: 0 });
    const before = await counts();
    const late = await item(
      bearer,
      batchId,
      randomUUID(),
      body({ name: "Fictional After Race" }),
    );
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject(expiredError);
    expect(await counts()).toEqual(before);
    expect(await tombstone(batchId)).toEqual({ purged: true, items: 0 });
  });

  it("(t) refuses and hides a purged batch even while its expiry is still in the future", async () => {
    const bearer = await token(owner);
    const batchId = randomUUID(),
      itemId = randomUUID();
    const json = body({ name: "Fictional Early Tombstone" });
    expect((await item(bearer, batchId, itemId, json)).status).toBe(201);
    const shown = await list(bearer, "?pageSize=20");
    expect(shown.body.data.map((entry: { id: string }) => entry.id)).toContain(
      batchId,
    );
    await asOwner("DELETE FROM app.bulk_intake_items WHERE batch_id=$1", [
      batchId,
    ]);
    await asOwner(
      "UPDATE app.bulk_intake_batches SET purged_at=now() WHERE id=$1",
      [batchId],
    );
    const before = await counts();
    for (const response of [
      await item(bearer, batchId, itemId, json),
      await upload(bearer, batchId, itemId),
    ]) {
      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject(expiredError);
    }
    expect(await counts()).toEqual(before);
    const hidden = await list(bearer, "?pageSize=20");
    expect(
      hidden.body.data.map((entry: { id: string }) => entry.id),
    ).not.toContain(batchId);
    expect(hidden.body.pagination.total).toBe(shown.body.pagination.total - 1);
    const read = await batch(bearer, batchId);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("not_found");
  });
});
