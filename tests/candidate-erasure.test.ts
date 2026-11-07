import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createFakeExtraction } from "./helpers/fake-extraction";

vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
// Every Blob gateway comes from this fake through the storage module; nothing remote is contacted.
const configured = vi.hoisted(() => ({
  current: undefined as undefined | { binding: unknown; gateway: unknown },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    storageConfigured: () => true,
    resolveStorageBinding: () => {
      if (!configured.current)
        throw new original.StorageConfigurationError("No fake storage.");
      return configured.current.binding;
    },
    getStorage: async () => configured.current?.gateway,
  };
});
const ai = vi.hoisted(() => ({ fake: false }));
const fakeAi = createFakeExtraction();
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...original,
    extractionProvider: () =>
      ai.fake ? fakeAi.provider : original.extractionProvider(),
  };
});
// The script loads .env.local when it exists; the tests keep their own environment.
vi.mock("../scripts/load-env", () => ({}));

import type { TeamTx } from "@/db";
import { getVerifiedSession } from "@/lib/auth-session";
import { createToken } from "@/lib/api-tokens";
import {
  currentDisclosure,
  recordConsent,
  runExtractionJob,
} from "@/lib/ai-extraction";
import {
  beginBulkItemUpload,
  bulkItemSchema,
  createBulkItem,
  getBulkBatch,
} from "@/lib/bulk-intake";
import { eraseCandidate } from "@/lib/candidate-erasure";
import { beginCvUpload, completeCvUpload, listCandidateCvs } from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { markNotifications, notifications } from "@/lib/insights";
import { listTools, TOOLS } from "@/lib/mcp/tools";
import type { Principal } from "@/lib/principal";
import {
  bootstrapTeam,
  createRecord,
  listRecords,
  updateCandidateState,
} from "@/lib/records";
import { POST as erasureRoute } from "@/app/api/v1/candidates/[id]/erasure/route";
import {
  main as eraseScript,
  MISMATCH,
  REFUSED,
  USAGE,
} from "../scripts/erase-candidate";
import {
  createSplitRoleDb,
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { blobBinding, fakeBlob } from "./helpers/fake-blob";
import { setDbForTests } from "@/db";

// Fictional people, teams and synthetic PDF bytes only; the fake Blob client stores nothing remote.
const ORIGIN = "http://localhost:3000";
const CANARY = {
  key: "canary",
  name: "Zephyrine Quillfeather",
  email: "zephyrine.erasure@example.test",
  phone: "+971 50 000 7319",
  file: "zephyrine-erasure-cv.pdf",
};
const SECOND = {
  key: "second",
  name: "Fictional Second Erasure Candidate",
  email: "second.erasure@example.test",
  phone: "+971 50 000 1111",
  file: "second-erasure-cv.pdf",
};
const TEAM_B_PERSON = { ...CANARY, key: "team-b" };
const REDACTED = "Details removed by candidate erasure";
const COUNT_KEYS = [
  "applications",
  "interviews",
  "offers",
  "onboarding",
  "checklistItems",
  "comments",
  "followUpStates",
  "tasksUnlinked",
  "savedViewsCleared",
  "bulkItems",
  "cvFiles",
  "activityRedacted",
  "notificationReads",
  "idempotencyKeys",
];
function fictionalPdf(size: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  bytes.write("%PDF-1.7\nfictional erasure CV\n");
  return bytes;
}
const pdf = fictionalPdf(1000);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
type Person = typeof CANARY;
type Built = {
  candidate: string;
  applications: string[];
  interviews: string[];
  offers: string[];
  onboarding: string[];
  checklists: string[];
  comments: string[];
  task: string;
  view: string;
  erased: string[];
};
type Ledger = {
  store: {
    used: number;
    retained: number;
    usedFiles: number;
    retainedFiles: number;
  }[];
  team: {
    used: number;
    retained: number;
    usedFiles: number;
    retainedFiles: number;
  }[];
};
type Row = { table: string; team: string | null; text: string };

/** Console output while `work` runs; nothing is printed. */
async function captureConsole<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
  );
  try {
    return { result: await work(), output: lines.join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
/** No canary value, object key or signed URL in console output. */
function expectQuiet(output: string, keys: string[] = []) {
  for (const value of [CANARY.name, CANARY.email, CANARY.phone, CANARY.file])
    expect(output.toLowerCase()).not.toContain(value.toLowerCase());
  expect(output.replace(/\D/g, "")).not.toContain("971500007319");
  for (const key of keys) expect(output).not.toContain(key);
  expect(output).not.toMatch(/https?:\/\/|vercel-blob|teams\//);
}

describe("candidate erasure", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let ownerA: Principal,
    adminA: Principal,
    recruiterA: Principal,
    viewerA: Principal,
    ownerB: Principal,
    recruiterB: Principal;
  const fake = fakeBlob();
  let canary: Built, second: Built, teamB: Built, bulkVersion: Built;
  let canaryCv: { id: string; key: string };
  let bulkCv: { id: string; key: string };
  let bulkItem: { batchId: string; itemId: string };
  let requestId: string;
  let ledgerBeforeCv: Ledger;
  let snapshotBefore: string[];
  let vacancyId: string;

  /** Raw SQL as the PGlite bootstrap superuser, outside the runtime role and its policies. */
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
  /** Every row of every app and storage_ledger table as text, with its team when it has one. */
  async function allRows(): Promise<Row[]> {
    const tables = await asOwner<{ name: string; team: boolean }>(
      `SELECT n.nspname || '.' || c.relname AS name,
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped) AS team
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('app', 'storage_ledger') AND c.relkind = 'r' ORDER BY 1`,
    );
    const rows: Row[] = [];
    for (const table of tables)
      for (const row of await asOwner<{ team: string | null; text: string }>(
        `SELECT ${table.team ? "team_id" : "NULL::text"} AS team, row_to_json(t)::text AS text FROM ${table.name} t ORDER BY 2`,
      ))
        rows.push({ table: table.name, ...row });
    return rows;
  }
  /** Team B's rows and every row naming the second team A candidate's records. */
  async function untouched() {
    return (await allRows())
      .filter(
        (row) =>
          row.team === ownerB.teamId ||
          second.erased.some((id) => row.text.includes(id)) ||
          row.text.includes(second.task) ||
          row.text.includes(second.view),
      )
      .map((row) => `${row.table} ${row.text}`);
  }
  async function ledger(teamId = ownerA.teamId): Promise<Ledger> {
    return {
      store: await asOwner(
        'SELECT used_bytes::int AS used, retained_bytes::int AS retained, used_files AS "usedFiles", retained_files AS "retainedFiles" FROM storage_ledger.stores WHERE provider=\'blob\' AND store=$1',
        [blobBinding.store],
      ),
      team: await asOwner(
        'SELECT used_bytes::int AS used, retained_bytes::int AS retained, used_files AS "usedFiles", retained_files AS "retainedFiles" FROM app.storage_usage WHERE team_id=$1',
        [teamId],
      ),
    };
  }
  const plus = (base: Ledger, field: "used" | "retained", bytes: number) => {
    const files = field === "used" ? "usedFiles" : "retainedFiles";
    const add = (row: Ledger["store"][number]) => ({
      ...row,
      [field]: row[field] + bytes,
      [files]: row[files] + Math.sign(bytes),
    });
    return { store: base.store.map(add), team: base.team.map(add) };
  };
  const signIn = (p: Principal) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId },
      session: { activeOrganizationId: p.teamId },
    } as never);
  async function post(
    id: string,
    body: unknown,
    headers: Record<string, string> = { origin: ORIGIN },
  ) {
    const response = await erasureRoute(
      new Request(`${ORIGIN}/api/v1/candidates/${id}/erasure`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
    return { status: response.status, body: await response.json() };
  }
  async function readyCv(p: Principal, candidate: string, file: string) {
    const reserved = await beginCvUpload(
      p,
      candidate,
      {
        originalName: file,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        clientUploadId: randomUUID(),
      },
      fake.gateway,
    );
    const [{ object_key: key }] = await asOwner<{ object_key: string }>(
      "SELECT object_key FROM app.uploads WHERE id=$1",
      [reserved.data.id],
    );
    fake.objects.set(key, { bytes: pdf, mimeType: "application/pdf" });
    expect(
      (await completeCvUpload(p, reserved.data.id, fake.gateway)).status,
    ).toBe("ready");
    return { id: reserved.data.id, key };
  }
  const expireUpload = (id: string, minutes = 11) =>
    asOwner(
      "UPDATE app.uploads SET expires_at=now()-make_interval(mins=>$2) WHERE id=$1",
      [id, minutes],
    );
  /** Holds the team's cleanup cooldown, so fixture completions start no automatic sweep. */
  const holdCooldown = (teamId: string) =>
    asOwner(
      `INSERT INTO storage_ledger.blob_reconciliation_claims(store,team_id,claimed_at) VALUES($1,$2,now()+interval '1 day')
       ON CONFLICT (store,team_id) DO UPDATE SET claimed_at=now()+interval '1 day'`,
      [blobBinding.store, teamId],
    );
  const firstBucket = async (p: Principal) =>
    (await listRecords(p, "buckets", new URLSearchParams())).data[0].id;

  /** A candidate with the full set of attached records, created through the app's own functions. */
  async function build(
    owner: Principal,
    member: Principal,
    person: Person,
  ): Promise<Built> {
    const vacancies: string[] = [];
    for (const n of [1, 2])
      vacancies.push(
        (
          await createRecord(owner, "vacancies", {
            data: {
              title: `Fictional erasure vacancy ${person.key} ${n}`,
              status: "Open",
            },
          })
        ).id,
      );
    const candidate = (
      await createRecord(
        owner,
        "candidates",
        {
          data: { name: person.name, email: person.email, phone: person.phone },
        },
        `create-${person.key}`,
      )
    ).id;
    const built: Built = {
      candidate,
      applications: [],
      interviews: [],
      offers: [],
      onboarding: [],
      checklists: [],
      comments: [],
      task: "",
      view: "",
      erased: [],
    };
    for (const [n, vacancy] of vacancies.entries()) {
      const application = (
        await createRecord(
          owner,
          "applications",
          {
            candidateId: candidate,
            vacancyId: vacancy,
            data: { stage: "Interview" },
          },
          `application-${person.key}-${n}`,
        )
      ).id;
      built.applications.push(application);
      built.interviews.push(
        (
          await createRecord(owner, "interviews", {
            applicationId: application,
            data: {
              title: `Fictional interview ${n}`,
              startAt: new Date(Date.now() + 86_400_000).toISOString(),
              status: "Scheduled",
            },
          })
        ).id,
      );
      built.offers.push(
        (
          await createRecord(owner, "offers", {
            applicationId: application,
            data: { title: `Fictional offer ${n}`, amount: "15000" },
          })
        ).id,
      );
      const onboarding = (
        await createRecord(owner, "onboarding", {
          applicationId: application,
          data: { status: "Planned" },
        })
      ).id;
      built.onboarding.push(onboarding);
      built.checklists.push(
        (
          await createRecord(owner, "checklist", {
            onboardingId: onboarding,
            data: { title: `Fictional ID copy ${n}` },
          })
        ).id,
      );
    }
    const onCandidate = (
      await createRecord(
        owner,
        "comments",
        {
          parentRecordId: candidate,
          data: { body: `Spoke with ${person.name}` },
        },
        `comment-${person.key}`,
      )
    ).id;
    built.comments.push(onCandidate);
    for (const [parent, body] of [
      [onCandidate, `Reply about ${person.name}`],
      [built.applications[0], `${person.email} confirmed the slot`],
      [built.interviews[0], `Interview notes for ${person.name}`],
    ])
      built.comments.push(
        (
          await createRecord(member, "comments", {
            parentRecordId: parent,
            data: { body },
          })
        ).id,
      );
    // The "Create hire task" prefill, saved with an Idempotency-Key as the editor does.
    built.task = (
      await createRecord(
        owner,
        "tasks",
        {
          bucketId: await firstBucket(owner),
          candidateId: candidate,
          data: {
            title: `Recruit ${person.name}`,
            context: person.name,
            description: `Call ${person.name.toUpperCase()} on Monday.`,
          },
        },
        `task-${person.key}`,
      )
    ).id;
    await updateCandidateState(owner, candidate, {
      version: 0,
      status: "Contacted",
      note: `Call ${person.name} back`,
    });
    await updateCandidateState(member, candidate, {
      version: 0,
      shortlisted: true,
      note: `${person.phone} answered`,
    });
    built.view = (
      await createRecord(
        member,
        "views",
        {
          data: {
            name: `Fictional search ${person.key}`,
            area: "directory",
            query: { search: person.email },
          },
        },
        `view-${person.key}`,
      )
    ).id;
    for (const p of [owner, member]) {
      const keys = (await notifications(p)).data
        .map((item) => item.key)
        .filter((key) => built.interviews.some((id) => key.includes(id)));
      expect(keys).toHaveLength(2);
      await markNotifications(p, keys);
    }
    built.erased = [
      candidate,
      ...built.applications,
      ...built.interviews,
      ...built.offers,
      ...built.onboarding,
      ...built.checklists,
      ...built.comments,
    ];
    return built;
  }

  /** The same person imported again through bulk intake, with reviewed AI suggestions and a CV. */
  async function bulkImport(owner: Principal, acknowledged: string) {
    const disclosure = currentDisclosure;
    ai.fake = true;
    try {
      await recordConsent(owner, "grant", disclosure()!.version);
      fakeAi.answer({
        kind: "return",
        output: { jobTitle: "Fictional Analyst" },
      });
      requestId = randomUUID();
      await runExtractionJob(owner, {
        requestId,
        disclosureVersion: disclosure()!.version,
        file: {
          originalName: CANARY.file,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          sha256: sha256(pdf),
        },
        content: pdf.toString("base64"),
      });
    } finally {
      ai.fake = false;
    }
    bulkItem = { batchId: randomUUID(), itemId: randomUUID() };
    const item = await createBulkItem(
      owner,
      bulkItem.batchId,
      bulkItem.itemId,
      bulkItemSchema.parse({
        file: {
          originalName: CANARY.file,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
        },
        data: { name: CANARY.name, email: CANARY.email, phone: CANARY.phone },
        factsReviewed: true,
        duplicatesReviewed: true,
        acknowledgedDuplicateIds: [acknowledged],
        aiReview: { requestId, decisions: { jobTitle: "accepted" } },
      }),
    );
    const reserved = await beginBulkItemUpload(
      owner,
      bulkItem.batchId,
      bulkItem.itemId,
    );
    const [{ object_key: key }] = await asOwner<{ object_key: string }>(
      "SELECT object_key FROM app.uploads WHERE id=$1",
      [reserved.data.id],
    );
    fake.objects.set(key, { bytes: pdf, mimeType: "application/pdf" });
    await completeCvUpload(owner, reserved.data.id, fake.gateway);
    bulkCv = { id: reserved.data.id, key };
    return item.candidateId!;
  }

  beforeAll(async () => {
    stubLocalAuthReadiness();
    fixture = await createTestDb();
    ownerA = await seedIdentity(fixture.db, {
      userId: "erase-owner-a",
      teamId: "erase-a",
    });
    adminA = await seedIdentity(fixture.db, {
      userId: "erase-admin-a",
      teamId: "erase-a",
      role: "admin",
    });
    recruiterA = await seedIdentity(fixture.db, {
      userId: "erase-recruiter-a",
      teamId: "erase-a",
      role: "recruiter",
    });
    viewerA = await seedIdentity(fixture.db, {
      userId: "erase-viewer-a",
      teamId: "erase-a",
      role: "viewer",
    });
    await seedIdentity(fixture.db, {
      userId: "erase-unverified-a",
      teamId: "erase-a",
      emailVerified: false,
    });
    ownerB = await seedIdentity(fixture.db, {
      userId: "erase-owner-b",
      teamId: "erase-b",
    });
    recruiterB = await seedIdentity(fixture.db, {
      userId: "erase-recruiter-b",
      teamId: "erase-b",
      role: "recruiter",
    });
    await enforceTestRls(fixture.db);
    configured.current = { binding: blobBinding, gateway: fake.gateway };
    for (const p of [ownerA, ownerB]) {
      await bootstrapTeam(p);
      await holdCooldown(p.teamId);
    }
    vacancyId = (
      await createRecord(ownerA, "vacancies", {
        data: { title: "Fictional unrelated vacancy", status: "Open" },
      })
    ).id;
    teamB = await build(ownerB, recruiterB, TEAM_B_PERSON);
    await readyCv(ownerB, teamB.candidate, TEAM_B_PERSON.file);
    second = await build(ownerA, recruiterA, SECOND);
    await readyCv(ownerA, second.candidate, SECOND.file);
    canary = await build(ownerA, recruiterA, CANARY);
    const bulkCandidate = await bulkImport(ownerA, canary.candidate);
    bulkVersion = {
      ...canary,
      candidate: bulkCandidate,
      erased: [bulkCandidate],
    };
    ledgerBeforeCv = await ledger();
    canaryCv = await readyCv(ownerA, canary.candidate, CANARY.file);
    await expireUpload(canaryCv.id);
    snapshotBefore = await untouched();
  });
  beforeEach(() => {
    fake.state.calls = [];
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("refuses admins, recruiters, viewers, tokens, a wrong name, another team and a vacancy, changing nothing", async () => {
    const before = await allRows();
    for (const p of [adminA, recruiterA, viewerA]) {
      signIn(p);
      expect(
        await post(canary.candidate, { confirmName: CANARY.name }),
      ).toMatchObject({
        status: 403,
        body: { error: { code: "erasure_forbidden" } },
      });
    }
    const { token } = await createToken(ownerA, {
      name: "Fictional erasure token",
      scopes: ["candidates:read", "candidates:write"],
    });
    expect(
      await post(
        canary.candidate,
        { confirmName: CANARY.name },
        { authorization: `Bearer ${token}` },
      ),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "session_required" } },
    });
    signIn(ownerA);
    for (const confirmName of ["Zephyrine", "zephyrine quillfeather", " "])
      expect(await post(canary.candidate, { confirmName })).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "erasure_confirmation_mismatch",
            message: "Type the candidate's name exactly as shown to confirm.",
          },
        },
      });
    expect(await post(canary.candidate, {})).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_input" } },
    });
    expect(
      await post("not-a-uuid", { confirmName: CANARY.name }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_input" } },
    });
    expect(await post(vacancyId, { confirmName: CANARY.name })).toMatchObject({
      status: 404,
      body: {
        error: { code: "not_found", message: "Record not found in this team." },
      },
    });
    signIn(ownerB);
    expect(
      await post(canary.candidate, { confirmName: CANARY.name }),
    ).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    // The token's own audit row is the only change; erasure refusals write nothing.
    const after = await allRows();
    const texts = (rows: Row[]) => new Set(rows.map((row) => row.text));
    expect(before.filter((row) => !texts(after).has(row.text))).toEqual([]);
    const added = after.filter((row) => !texts(before).has(row.text));
    expect(added.map((row) => row.table)).toEqual(["app.activity"]);
    expect(added[0].text).toContain('"kind":"api-token"');
  });

  it("refuses the helper under an admin session or an owner token context, and MCP offers no erasure", async () => {
    const call = (p: Principal) =>
      withTeam(p, (tx: TeamTx) =>
        tx.execute(
          sql`select tenant_context.erase_candidate(${canary.candidate}::uuid, ${CANARY.name}, 'app')`,
        ),
      ).catch((error: { cause?: { code?: string } }) => error.cause?.code);
    const ownerToken = await seedApiToken(fixture.db, ownerA);
    expect(await call(adminA)).toBe("42501");
    expect(await call(ownerToken)).toBe("42501");
    expect(
      await withTeam(ownerToken, (tx) =>
        tx.execute(
          sql`select tenant_context.audit_mcp_call('erase_candidate', 'allowed')`,
        ),
      ).catch((error: { cause?: { code?: string } }) => error.cause?.code),
    ).toBe("42501");
    const names = [
      ...TOOLS.map((tool) => tool.name),
      ...listTools(ownerToken).map((tool) => tool.name),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((name) => /eras|delet|purge|remove/i.test(name)),
    ).toEqual([]);
    expect(await asOwner("SELECT 1 FROM app.candidate_erasures")).toEqual([]);
  });

  describe("an owner's erasure through the route", () => {
    let response: { status: number; body: { data: Record<string, unknown> } };
    let activityBefore: Record<string, unknown>[];
    let activityCount: number;
    let tombstone: string;
    let seen: unknown[];
    let output: string;

    beforeAll(async () => {
      activityBefore = await asOwner(
        "SELECT id, actor_id, actor_type, token_id, action, kind, created_at FROM app.activity WHERE record_id = ANY($1::uuid[]) ORDER BY id",
        [canary.erased],
      );
      activityCount = Number(
        (
          await asOwner<{ n: string }>("SELECT count(*) AS n FROM app.activity")
        )[0].n,
      );
      seen = [];
      fake.state.beforeCall = async (call) => {
        if (call.endsWith(canaryCv.key)) seen.push([call, await ledger()]);
      };
      signIn(ownerA);
      fake.state.calls = [];
      const captured = await captureConsole(() =>
        post(canary.candidate, { confirmName: `  ${CANARY.name} ` }),
      );
      fake.state.beforeCall = undefined;
      response = captured.result;
      output = captured.output;
      tombstone = response.body.data?.erasureId as string;
    });

    it("answers 200 with the tombstone, the counts and the CV storage figures", () => {
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        erasureId: expect.any(String),
        alreadyErased: false,
        erasedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        removed: {
          applications: 2,
          interviews: 2,
          offers: 2,
          onboarding: 2,
          checklistItems: 2,
          comments: 4,
          followUpStates: 2,
          tasksUnlinked: 1,
          savedViewsCleared: 1,
          bulkItems: 0,
          cvFiles: 1,
          activityRedacted: activityBefore.length,
          notificationReads: 4,
          // Candidate, two applications, the comment, the task, the CV reservation and the view.
          idempotencyKeys: 7,
        },
        cvStorage: { deleted: 1, waiting: 0, deleteAfter: null },
      });
      expectQuiet(output, [canaryCv.key]);
    });

    it("leaves no record, follow-up state or notification read of the erased set", async () => {
      expect(
        await asOwner("SELECT id FROM app.records WHERE id = ANY($1::uuid[])", [
          canary.erased,
        ]),
      ).toEqual([]);
      expect(
        await asOwner(
          "SELECT user_id FROM app.candidate_states WHERE candidate_id=$1",
          [canary.candidate],
        ),
      ).toEqual([]);
      expect(
        await asOwner(
          "SELECT key FROM app.notification_reads WHERE split_part(key, ':', 2) = ANY($1::text[])",
          [canary.erased],
        ),
      ).toEqual([]);
    });

    it("redacts every activity row about the erased set and keeps its type, actor and time", async () => {
      const after = await asOwner<Record<string, unknown>>(
        "SELECT id, actor_id, actor_type, token_id, action, kind, created_at, record_id, erasure_id, summary, metadata FROM app.activity WHERE id = ANY($1::uuid[]) ORDER BY id",
        [activityBefore.map((row) => row.id)],
      );
      expect(activityBefore.length).toBeGreaterThan(15);
      expect(
        after.map(({ record_id, erasure_id, summary, metadata, ...kept }) => {
          expect({ record_id, erasure_id, summary, metadata }).toEqual({
            record_id: null,
            erasure_id: tombstone,
            summary: REDACTED,
            metadata: {},
          });
          return kept;
        }),
      ).toEqual(activityBefore);
      expect(
        Number(
          (
            await asOwner<{ n: string }>(
              "SELECT count(*) AS n FROM app.activity",
            )
          )[0].n,
        ),
      ).toBe(activityCount + 1);
    });

    it("records one tombstone and one candidate.erased row without personal data", async () => {
      const tombstones = await asOwner<Record<string, unknown>>(
        "SELECT * FROM app.candidate_erasures WHERE team_id=$1 AND candidate_id=$2",
        [ownerA.teamId, canary.candidate],
      );
      expect(tombstones).toEqual([
        {
          id: tombstone,
          team_id: ownerA.teamId,
          candidate_id: canary.candidate,
          erased_by: ownerA.userId,
          erased_at: expect.any(Date),
        },
      ]);
      const audit = await asOwner<Record<string, unknown>>(
        "SELECT team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata FROM app.activity WHERE erasure_id=$1 AND action='candidate.erased'",
        [tombstone],
      );
      expect(audit).toEqual([
        {
          team_id: ownerA.teamId,
          record_id: null,
          actor_id: ownerA.userId,
          actor_type: "session",
          token_id: null,
          action: "candidate.erased",
          kind: "candidate-erasure",
          summary: "Permanently erased a candidate",
          metadata: {
            source: "app",
            ...(response.body.data.removed as object),
          },
        },
      ]);
      expect(Object.keys(audit[0].metadata as object).sort()).toEqual(
        ["source", ...COUNT_KEYS].sort(),
      );
    });

    it("keeps the hire task and the saved view, unlinked and cleaned, and keeps the CV row nameless", async () => {
      const [task] = await asOwner<{
        candidate_id: string | null;
        version: number;
        data: Record<string, string>;
      }>("SELECT candidate_id, version, data FROM app.records WHERE id=$1", [
        canary.task,
      ]);
      expect(task.candidate_id).toBeNull();
      expect(task.version).toBe(2);
      expect(task.data).toMatchObject({
        title: "Recruit [erased candidate]",
        context: "[erased candidate]",
        description: "Call [erased candidate] on Monday.",
      });
      const [view] = await asOwner<{
        version: number;
        private_owner_id: string;
        data: { query: { search: string } };
      }>(
        "SELECT version, private_owner_id, data FROM app.records WHERE id=$1",
        [canary.view],
      );
      expect(view).toMatchObject({
        version: 2,
        private_owner_id: recruiterA.userId,
      });
      expect(view.data.query.search).toBe("");
      expect(
        await asOwner(
          "SELECT status, erasure_id, candidate_id, original_name, source_path, legacy_source_id, blob_sha256, object_key FROM app.uploads WHERE id=$1",
          [canaryCv.id],
        ),
      ).toEqual([
        {
          status: "rejected",
          erasure_id: tombstone,
          candidate_id: null,
          original_name: null,
          source_path: null,
          legacy_source_id: null,
          blob_sha256: null,
          object_key: canaryCv.key,
        },
      ]);
    });

    it("deletes the expired CV, confirms it by head, and only then releases the retained charge", async () => {
      const size = pdf.length;
      expect(seen).toEqual([
        [`delete:${canaryCv.key}`, plus(ledgerBeforeCv, "retained", size)],
        [`head:${canaryCv.key}`, plus(ledgerBeforeCv, "retained", size)],
      ]);
      expect(fake.objects.has(canaryCv.key)).toBe(false);
      expect(await ledger()).toEqual(ledgerBeforeCv);
      const [row] = await asOwner<{ blob_deleted_at: Date | null }>(
        "SELECT blob_deleted_at FROM app.uploads WHERE id=$1",
        [canaryCv.id],
      );
      expect(row.blob_deleted_at).toBeInstanceOf(Date);
    });

    it("leaves the second candidate and all of team B unchanged", async () => {
      expect(await untouched()).toEqual(snapshotBefore);
      expect(snapshotBefore.length).toBeGreaterThan(50);
    });

    it("answers a retry with the same erasure and changes nothing; a create replay is refused", async () => {
      const before = await allRows();
      signIn(ownerA);
      const retry = await post(canary.candidate, { confirmName: "Anything" });
      expect(retry).toEqual({
        status: 200,
        body: {
          data: {
            erasureId: tombstone,
            alreadyErased: true,
            erasedAt: response.body.data.erasedAt,
            removed: null,
            cvStorage: { deleted: 1, waiting: 0, deleteAfter: null },
          },
        },
      });
      expect(await allRows()).toEqual(before);
      expect(
        await asOwner(
          "SELECT id FROM app.candidate_erasures WHERE candidate_id=$1",
          [canary.candidate],
        ),
      ).toHaveLength(1);
      expect(
        await asOwner(
          "SELECT id FROM app.activity WHERE erasure_id=$1 AND action='candidate.erased'",
          [tombstone],
        ),
      ).toHaveLength(1);
      await expect(
        createRecord(
          ownerA,
          "candidates",
          {
            data: {
              name: CANARY.name,
              email: CANARY.email,
              phone: CANARY.phone,
            },
          },
          `create-${CANARY.key}`,
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_expired" });
      expect(
        await asOwner(
          "SELECT id FROM app.records WHERE team_id=$1 AND kind='candidate' AND data->>'email'=$2 AND id<>$3",
          [ownerA.teamId, CANARY.email, bulkVersion.candidate],
        ),
      ).toEqual([]);
    });
  });

  describe("the owner-run script", () => {
    const args = (overrides: Record<string, string> = {}) =>
      Object.entries({
        team: ownerA.teamId,
        candidate: bulkVersion.candidate,
        owner: `${ownerA.userId}@example.test`,
        "confirm-name": CANARY.name,
        ...overrides,
      }).flatMap(([flag, value]) => [`--${flag}`, value]);
    const run = (argv: string[]) => captureConsole(() => eraseScript(argv));

    it("refuses a non-owner, an unverified owner, another team, missing arguments and a wrong name, changing nothing", async () => {
      const before = await allRows();
      for (const [argv, line] of [
        [args({ owner: `${adminA.userId}@example.test` }), REFUSED],
        [args({ owner: "erase-unverified-a@example.test" }), REFUSED],
        [args({ owner: "nobody@example.test" }), REFUSED],
        [args({ team: "erase-b" }), REFUSED],
        [args().slice(0, 6), USAGE],
        [[...args(), "--extra", "x"], USAGE],
        [[...args(), "--team", ownerA.teamId], USAGE],
        [args({ "confirm-name": "Zephyrine" }), MISMATCH],
      ] as const) {
        const { result, output } = await run([...argv]);
        expect(result).toBe(1);
        expect(output).toBe(line);
      }
      expect(await allRows()).toEqual(before);
    });

    it("erases the bulk-imported version with source script and redacts its AI suggestion records", async () => {
      const aiBefore = await asOwner<Record<string, unknown>>(
        "SELECT id, actor_id, action, kind, created_at FROM app.activity WHERE kind='ai-extraction' AND metadata->>'requestId'=$1 ORDER BY id",
        [requestId],
      );
      expect(aiBefore).toHaveLength(2);
      const { result, output } = await run(args());
      expect(result).toBe(0);
      expectQuiet(output, [bulkCv.key]);
      const lines = output.split("\n");
      expect(lines[0]).toMatch(/^Erasure id: [0-9a-f-]{36}$/);
      expect(lines.slice(1)).toEqual([
        "Already erased: false",
        expect.stringMatching(
          /^Removed: applications=0, .*bulkItems=1, cvFiles=1, /,
        ),
        expect.stringMatching(
          /^CV storage: deleted=0, waiting=1, deleteAfter=\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
        ),
      ]);
      const erasureId = lines[0].slice("Erasure id: ".length);
      const [audit] = await asOwner<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM app.activity WHERE erasure_id=$1 AND action='candidate.erased'",
        [erasureId],
      );
      expect(audit.metadata).toMatchObject({
        source: "script",
        bulkItems: 1,
        cvFiles: 1,
      });
      const aiAfter = await asOwner<Record<string, unknown>>(
        "SELECT id, actor_id, action, kind, created_at, record_id, erasure_id, summary, metadata FROM app.activity WHERE id = ANY($1::uuid[]) ORDER BY id",
        [aiBefore.map((row) => row.id)],
      );
      expect(aiAfter).toEqual(
        aiBefore.map((row) => ({
          ...row,
          record_id: null,
          erasure_id: erasureId,
          summary: REDACTED,
          metadata: { requestId },
        })),
      );
      // The request id stays, so the used AI request is still refused.
      ai.fake = true;
      try {
        await expect(
          runExtractionJob(ownerA, {
            requestId,
            disclosureVersion: currentDisclosure()!.version,
            file: {
              originalName: "fictional-other.pdf",
              mimeType: "application/pdf",
              sizeBytes: pdf.length,
              sha256: sha256(pdf),
            },
            content: pdf.toString("base64"),
          }),
        ).rejects.toMatchObject({ status: 409, code: "ai_request_used" });
      } finally {
        ai.fake = false;
      }
      expect(
        await asOwner(
          "SELECT erased_at IS NOT NULL AS erased, original_name, mime_type, size_bytes, payload_hash, reviewed_at, possible_duplicates, candidate_id, upload_id, upload_key FROM app.bulk_intake_items WHERE id=$1",
          [bulkItem.itemId],
        ),
      ).toEqual([
        {
          erased: true,
          original_name: null,
          mime_type: null,
          size_bytes: null,
          payload_hash: null,
          reviewed_at: null,
          possible_duplicates: null,
          candidate_id: null,
          upload_id: null,
          upload_key: null,
        },
      ]);
      expect(await untouched()).toEqual(snapshotBefore);
    });

    it("leaves no name, email, phone or file name in any team A row; team B keeps its own", async () => {
      const rows = await allRows();
      const teamA = rows.filter((row) => row.team !== ownerB.teamId);
      expect(teamA.length).toBeGreaterThan(100);
      for (const row of teamA) {
        const text = row.text.toLowerCase();
        for (const value of [
          CANARY.name,
          CANARY.email,
          CANARY.phone,
          CANARY.file,
        ])
          expect(text, row.table).not.toContain(value.toLowerCase());
        expect(row.text.replace(/\D/g, ""), row.table).not.toContain(
          "971500007319",
        );
      }
      expect(
        rows.some(
          (row) => row.team === ownerB.teamId && row.text.includes(CANARY.name),
        ),
      ).toBe(true);
    });
  });

  describe("Blob deletion failures", () => {
    async function candidateWithCv(name: string) {
      const id = (await createRecord(ownerA, "candidates", { data: { name } }))
        .id;
      const cv = await readyCv(ownerA, id, "fictional-failure-cv.pdf");
      await expireUpload(cv.id);
      return { id, cv };
    }
    const deletedAt = async (id: string) =>
      (
        await asOwner<{ blob_deleted_at: Date | null }>(
          "SELECT blob_deleted_at FROM app.uploads WHERE id=$1",
          [id],
        )
      )[0].blob_deleted_at;

    it("keeps the charge retained when the delete fails and finishes on a retry", async () => {
      const { id, cv } = await candidateWithCv("Fictional Delete Failure");
      const before = await ledger();
      fake.state.calls = [];
      fake.state.failDelete = true;
      const failed = await captureConsole(() =>
        eraseCandidate(ownerA, id, { confirmName: "Fictional Delete Failure" }),
      );
      fake.state.failDelete = false;
      expect(failed.result).toMatchObject({
        alreadyErased: false,
        cvStorage: { deleted: 0, waiting: 1 },
      });
      expectQuiet(failed.output, [cv.key]);
      expect(fake.state.calls).toEqual([`delete:${cv.key}`]);
      expect(await ledger()).toEqual(
        plus(plus(before, "used", -pdf.length), "retained", pdf.length),
      );
      expect(await deletedAt(cv.id)).toBeNull();
      fake.state.calls = [];
      const retry = await eraseCandidate(ownerA, id, { confirmName: "x" });
      expect(retry).toMatchObject({
        alreadyErased: true,
        removed: null,
        cvStorage: { deleted: 1, waiting: 0, deleteAfter: null },
      });
      expect(fake.state.calls).toEqual([`delete:${cv.key}`, `head:${cv.key}`]);
      expect(await ledger()).toEqual(plus(before, "used", -pdf.length));
    });

    it("counts an object head still finds as waiting and releases nothing", async () => {
      const { id, cv } = await candidateWithCv("Fictional Kept Object");
      const before = await ledger();
      fake.state.calls = [];
      fake.state.keepOnDelete = true;
      const kept = await eraseCandidate(ownerA, id, {
        confirmName: "Fictional Kept Object",
      });
      fake.state.keepOnDelete = false;
      expect(kept.cvStorage).toMatchObject({ deleted: 0, waiting: 1 });
      expect(fake.state.calls).toEqual([`delete:${cv.key}`, `head:${cv.key}`]);
      expect(fake.objects.has(cv.key)).toBe(true);
      expect(await ledger()).toEqual(
        plus(plus(before, "used", -pdf.length), "retained", pdf.length),
      );
      expect(await deletedAt(cv.id)).toBeNull();
    });
  });

  describe("erasure in the middle of a bulk import", () => {
    const person = (name: string) =>
      bulkItemSchema.parse({
        file: {
          originalName: `${name.toLowerCase().replaceAll(" ", "-")}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
        },
        data: {
          name,
          email: `${name.toLowerCase().replaceAll(" ", ".")}@example.test`,
        },
        factsReviewed: true,
        duplicatesReviewed: true,
        acknowledgedDuplicateIds: [],
      });

    it("refuses the erased item, never recreates it, waits for the ticket, then deletes its object", async () => {
      const batchId = randomUUID(),
        itemX = randomUUID(),
        itemY = randomUUID();
      const inputX = person("Fictional Midway Import");
      const inputY = person("Fictional Other Import");
      const x = await createBulkItem(recruiterA, batchId, itemX, inputX);
      await createBulkItem(recruiterA, batchId, itemY, inputY);
      const reserved = await beginBulkItemUpload(recruiterA, batchId, itemX);
      const [upload] = await asOwner<{
        object_key: string;
        expires_at: Date;
        status: string;
      }>("SELECT object_key, expires_at, status FROM app.uploads WHERE id=$1", [
        reserved.data.id,
      ]);
      expect(upload.status).toBe("pending");
      expect(upload.expires_at.getTime()).toBeGreaterThan(Date.now());
      const before = await ledger();
      fake.state.calls = [];
      const erased = await eraseCandidate(ownerA, x.candidateId!, {
        confirmName: "Fictional Midway Import",
      });
      expect(fake.state.calls).toEqual([]);
      expect(erased.cvStorage).toEqual({
        deleted: 0,
        waiting: 1,
        deleteAfter: new Date(
          upload.expires_at.getTime() + 600_000,
        ).toISOString(),
      });
      // The pending reservation's charge is now retained until the object can be deleted.
      expect(await ledger()).toEqual(plus(before, "retained", pdf.length));
      expect(
        await asOwner(
          "SELECT erased_at IS NOT NULL AS erased, original_name, candidate_id, upload_id, upload_key, payload_hash FROM app.bulk_intake_items WHERE id=$1",
          [itemX],
        ),
      ).toEqual([
        {
          erased: true,
          original_name: null,
          candidate_id: null,
          upload_id: null,
          upload_key: null,
          payload_hash: null,
        },
      ]);
      const refusal = {
        status: 409,
        code: "bulk_item_erased",
        message:
          "This candidate was permanently erased by a team owner. It cannot be imported again from this batch.",
      };
      await expect(
        createBulkItem(recruiterA, batchId, itemX, inputX),
      ).rejects.toMatchObject(refusal);
      await expect(
        beginBulkItemUpload(recruiterA, batchId, itemX),
      ).rejects.toMatchObject(refusal);
      expect(
        await asOwner(
          "SELECT id FROM app.records WHERE kind='candidate' AND data->>'name'='Fictional Midway Import'",
        ),
      ).toEqual([]);
      fake.objects.set(upload.object_key, {
        bytes: pdf,
        mimeType: "application/pdf",
      });
      await expect(
        completeCvUpload(recruiterA, reserved.data.id, fake.gateway),
      ).rejects.toMatchObject({ status: 404, code: "CV_NOT_FOUND" });
      expect(
        await asOwner("SELECT status FROM app.uploads WHERE id=$1", [
          reserved.data.id,
        ]),
      ).toEqual([{ status: "rejected" }]);
      expect(
        await asOwner(
          "SELECT id FROM app.activity WHERE action='cv.uploaded' AND metadata->>'uploadId'=$1",
          [reserved.data.id],
        ),
      ).toEqual([]);
      const batch = await getBulkBatch(recruiterA, batchId);
      expect(batch.items.map((item) => item.id)).toEqual([itemY]);
      const y = await beginBulkItemUpload(recruiterA, batchId, itemY);
      const [{ object_key: keyY }] = await asOwner<{ object_key: string }>(
        "SELECT object_key FROM app.uploads WHERE id=$1",
        [y.data.id],
      );
      fake.objects.set(keyY, { bytes: pdf, mimeType: "application/pdf" });
      expect(
        (await completeCvUpload(recruiterA, y.data.id, fake.gateway)).status,
      ).toBe("ready");
      expect(
        (await getBulkBatch(recruiterA, batchId)).items.map(
          (item) => item.outcome,
        ),
      ).toEqual(["imported"]);

      await expireUpload(reserved.data.id);
      const settled = await ledger();
      fake.state.calls = [];
      const retry = await eraseCandidate(ownerA, x.candidateId!, {
        confirmName: "Fictional Midway Import",
      });
      expect(retry).toMatchObject({
        alreadyErased: true,
        cvStorage: { deleted: 1, waiting: 0, deleteAfter: null },
      });
      expect(fake.state.calls).toEqual([
        `delete:${upload.object_key}`,
        `head:${upload.object_key}`,
      ]);
      expect(await ledger()).toEqual(plus(settled, "retained", -pdf.length));
      expect(
        await listCandidateCvs(recruiterA, y.data.candidateId!),
      ).toHaveLength(1);
    });
  });
});

describe("candidate erasure under the split runtime roles", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, member: Principal;
  let candidate: string, other: string, task: string, view: string;
  let comment: string, application: string, tombstone: string;
  let upload: { id: string; key: string };
  let otherUpload: string;
  let imported: { item: string; candidate: string };
  let liveItem: string;
  const fake = fakeBlob();

  /** Raw SQL in one data-role transaction under a signed context, always rolled back. */
  async function asData(p: Principal, statement: string) {
    await harness.dataDb();
    return withTeam(p, async (tx) => {
      const result = await tx.execute(sql.raw(statement));
      throw Object.assign(new Error("rollback"), { result });
    }).catch(
      (error: {
        result?: { rows: unknown[] };
        cause?: { code?: string; message?: string };
      }) =>
        error.result
          ? { rows: error.result.rows }
          : { code: error.cause?.code ?? "unknown" },
    );
  }
  const inspect = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    try {
      return (await harness.client.query<T>(query, params)).rows;
    } finally {
      await harness.dataDb();
    }
  };

  beforeAll(async () => {
    stubLocalAuthReadiness();
    harness = await createSplitRoleDb();
    const db = await harness.asOwner();
    owner = await seedIdentity(db, {
      userId: "split-owner",
      teamId: "split-a",
    });
    member = await seedIdentity(db, {
      userId: "split-recruiter",
      teamId: "split-a",
      role: "recruiter",
    });
    setDbForTests(harness.db);
    configured.current = { binding: blobBinding, gateway: fake.gateway };
    await harness.dataDb();
    await bootstrapTeam(owner);
    candidate = (
      await createRecord(
        owner,
        "candidates",
        {
          data: { name: CANARY.name, email: CANARY.email, phone: CANARY.phone },
        },
        "split-create",
      )
    ).id;
    other = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Split Other" },
      })
    ).id;
    const vacancy = (
      await createRecord(owner, "vacancies", {
        data: { title: "Fictional split vacancy" },
      })
    ).id;
    application = (
      await createRecord(owner, "applications", {
        candidateId: candidate,
        vacancyId: vacancy,
        data: {},
      })
    ).id;
    const interview = (
      await createRecord(owner, "interviews", {
        applicationId: application,
        data: {
          title: "Fictional split interview",
          startAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
    ).id;
    const onboarding = (
      await createRecord(owner, "onboarding", {
        applicationId: application,
        data: {},
      })
    ).id;
    await createRecord(owner, "checklist", {
      onboardingId: onboarding,
      data: { title: "Fictional split item" },
    });
    comment = (
      await createRecord(member, "comments", {
        parentRecordId: interview,
        data: { body: `About ${CANARY.name}` },
      })
    ).id;
    task = (
      await createRecord(owner, "tasks", {
        bucketId: (await listRecords(owner, "buckets", new URLSearchParams()))
          .data[0].id,
        candidateId: candidate,
        data: { title: `Recruit ${CANARY.name}`, context: CANARY.name },
      })
    ).id;
    await updateCandidateState(member, candidate, {
      version: 0,
      note: "Fictional",
    });
    view = (
      await createRecord(member, "views", {
        data: {
          name: "Fictional split view",
          area: "directory",
          query: { search: CANARY.phone },
        },
      })
    ).id;
    const keys = (await notifications(member)).data
      .map((entry) => entry.key)
      .filter((key) => key.includes(interview));
    await markNotifications(member, keys);
    const reserved = await beginCvUpload(
      owner,
      candidate,
      {
        originalName: CANARY.file,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        clientUploadId: randomUUID(),
      },
      fake.gateway,
    );
    const [{ object_key: key }] = await inspect<{ object_key: string }>(
      "SELECT object_key FROM app.uploads WHERE id=$1",
      [reserved.data.id],
    );
    upload = { id: reserved.data.id, key };
    fake.objects.set(key, { bytes: pdf, mimeType: "application/pdf" });
    await completeCvUpload(owner, upload.id, fake.gateway);
    otherUpload = (
      await beginCvUpload(
        owner,
        other,
        {
          originalName: "fictional-split-other.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          clientUploadId: randomUUID(),
        },
        fake.gateway,
      )
    ).data.id;
    const batch = randomUUID();
    const bulk = async (name: string) => {
      const id = randomUUID();
      const created = await createBulkItem(
        member,
        batch,
        id,
        bulkItemSchema.parse({
          file: {
            originalName: "fictional-split.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
          },
          data: { name },
          factsReviewed: true,
          duplicatesReviewed: true,
          acknowledgedDuplicateIds: [],
        }),
      );
      return { item: id, candidate: created.candidateId! };
    };
    imported = await bulk("Fictional Split Import");
    liveItem = (await bulk("Fictional Split Live Import")).item;
    // Only the schema owner may move an upload's expiry; the superuser is not that owner here.
    await harness.asOwner();
    await harness.client.query(
      "UPDATE app.uploads SET expires_at=now()-interval '11 minutes' WHERE id=$1",
      [upload.id],
    );
    await harness.dataDb();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("erases through the restricted data role with every member's rows and the ledger", async () => {
    const result = await eraseCandidate(owner, candidate, {
      confirmName: CANARY.name,
    });
    tombstone = result.erasureId;
    expect(result).toMatchObject({
      alreadyErased: false,
      removed: {
        applications: 1,
        interviews: 1,
        onboarding: 1,
        checklistItems: 1,
        comments: 1,
        followUpStates: 1,
        tasksUnlinked: 1,
        savedViewsCleared: 1,
        cvFiles: 1,
        notificationReads: 1,
        idempotencyKeys: 2,
      },
      cvStorage: { deleted: 1, waiting: 0, deleteAfter: null },
    });
    expect(
      await inspect("SELECT id FROM app.records WHERE id = ANY($1::uuid[])", [
        [candidate, application, comment],
      ]),
    ).toEqual([]);
    expect(
      await inspect(
        "SELECT candidate_id, data->>'title' AS title FROM app.records WHERE id=$1",
        [task],
      ),
    ).toEqual([{ candidate_id: null, title: "Recruit [erased candidate]" }]);
    expect(
      await inspect(
        "SELECT data->'query'->>'search' AS search FROM app.records WHERE id=$1",
        [view],
      ),
    ).toEqual([{ search: "" }]);
    expect(
      await inspect(
        "SELECT used_bytes::int AS used, retained_bytes::int AS retained FROM app.storage_usage WHERE team_id=$1",
        [owner.teamId],
      ),
    ).toEqual([{ used: 0, retained: 0 }]);
    expect(
      await inspect("SELECT id FROM app.records WHERE id=$1", [other]),
    ).toHaveLength(1);
    // A bulk-imported candidate: its item becomes a tombstone through the owner-only policy.
    expect(
      (
        await eraseCandidate(owner, imported.candidate, {
          confirmName: "Fictional Split Import",
        })
      ).removed,
    ).toMatchObject({ bulkItems: 1 });
    expect(
      await inspect(
        "SELECT erased_at IS NOT NULL AS erased, candidate_id FROM app.bulk_intake_items WHERE id=$1",
        [imported.item],
      ),
    ).toEqual([{ erased: true, candidate_id: null }]);
  });

  it("refuses the data role every direct write the erasure needs", async () => {
    const denied = (statement: string) => asData(owner, statement);
    for (const statement of [
      "SELECT * FROM app.candidate_erasures",
      `INSERT INTO app.candidate_erasures(id,team_id,candidate_id,erased_by,erased_at) VALUES (gen_random_uuid(),'split-a',gen_random_uuid(),'split-owner',now())`,
      "DELETE FROM app.activity",
      `DELETE FROM app.records WHERE id='${other}'`,
    ])
      expect(await denied(statement), statement).toEqual({ code: "42501" });
    expect(
      await denied(
        "UPDATE app.activity SET summary='Fictional' WHERE team_id='split-a'",
      ),
    ).toEqual({ code: "P0001" });
    for (const statement of [
      `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,erasure_id) VALUES ('split-a','split-owner','session','created','candidate','Fictional','${tombstone}')`,
      `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary) VALUES ('split-a','split-owner','session','candidate.erased','candidate-erasure','Fictional')`,
    ])
      expect(await denied(statement), statement).toEqual({ code: "42501" });
    expect(
      await denied(
        `UPDATE app.uploads SET erasure_id='${tombstone}' WHERE id='${otherUpload}'`,
      ),
    ).toEqual({ code: "23514" });
    const [{ batch_id: batch }] = await inspect<{ batch_id: string }>(
      "SELECT batch_id FROM app.bulk_intake_items WHERE id=$1",
      [liveItem],
    );
    const cleared =
      "erased_at=now(), original_name=NULL, mime_type=NULL, size_bytes=NULL, payload_hash=NULL, reviewed_at=NULL, possible_duplicates=NULL, candidate_id=NULL, upload_id=NULL, upload_key=NULL";
    expect(
      await asData(
        member,
        `INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,erased_at,created_at,updated_at) VALUES (gen_random_uuid(),'split-a','${batch}','split-recruiter',now(),now(),now())`,
      ),
    ).toEqual({ code: "42501" });
    expect(
      await asData(
        member,
        `UPDATE app.bulk_intake_items SET ${cleared} WHERE id='${liveItem}'`,
      ),
    ).toEqual({ code: "42501" });
    // A tombstoned item is outside the update and delete policies, so nothing matches.
    for (const statement of [
      `UPDATE app.bulk_intake_items SET updated_at=now() WHERE id='${imported.item}' RETURNING id`,
      `DELETE FROM app.bulk_intake_items WHERE id='${imported.item}' RETURNING id`,
    ])
      expect(await asData(member, statement), statement).toEqual({ rows: [] });
    expect(
      await asData(
        member,
        `SELECT id FROM app.bulk_intake_items WHERE id='${imported.item}'`,
      ),
    ).toEqual({ rows: [{ id: imported.item }] });
  });
});
