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

// R2b-08 (job 091): field rules on system and custom fields in every output, and refused writes,
// filters and sorts. Fictional data only, on a database of its own; the session lookup is mocked.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
// Bulk intake asks only whether uploads are set up; no case here sends a file.
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  storageConfigured: () => true,
}));

import type { RoleBody } from "@/domain/config";
import { ADMIN_ROLE, RECRUITER_ROLE } from "@/domain/config-defaults";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import {
  analytics,
  listActivity,
  notifications,
  overview,
} from "@/lib/insights";
import { callTool, TOOLS } from "@/lib/mcp/tools";
import { assignMemberRole } from "@/lib/member-roles";
import type { Principal } from "@/lib/principal";
import {
  bootstrapTeam,
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
} from "@/lib/records";
import { GET as openapiRoute } from "@/app/api/openapi.json/route";
import {
  GET as listRoute,
  POST as createRoute,
} from "@/app/api/v1/[resource]/route";
import {
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/v1/[resource]/[id]/route";
import { POST as exportRoute } from "@/app/api/v1/[resource]/export/route";
import { POST as bulkRoute } from "@/app/api/v1/applications/bulk/route";
import { POST as duplicatesRoute } from "@/app/api/v1/candidates/duplicates/route";
import { GET as suggestionsRoute } from "@/app/api/v1/candidates/suggestions/route";
import { POST as bulkItemRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/route";
import { GET as searchRoute } from "@/app/api/v1/search/route";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";
import {
  customField,
  insertKindSchema,
  kindBody,
} from "./helpers/kind-schemas";

const ORIGIN = "http://localhost:3000";
const AMOUNT = "81937";
const HIDDEN_VALUE = "Fictional hidden marker";
const VISIBLE_VALUE = "Fictional visible value";
const READ_ONLY_VALUE = "Fictional read-only value";
const HIDDEN_TASK_VALUE = "Fictional hidden task value";
const VACANCY_TITLE = "Fictional Hidden Vacancy Title";
type Handler = (request: Request, context: never) => Promise<Response>;
type Row = Record<string, unknown>;
type McpResult = Awaited<ReturnType<typeof callTool>> & {
  structuredContent: {
    untrustedData?: boolean;
    notice?: string;
    data?: unknown;
    error?: { code: string; message: string };
  };
};

describe("field rules in every output (R2b-08)", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, member: Principal, variant: Principal;
  let plain: Principal, builtin: Principal, importer: Principal;
  let ownerToken: Principal, memberToken: Principal;
  let plainToken: Principal, builtinToken: Principal;
  // The candidate kind schema's custom fields and the task kind schema's.
  const visible = customField("Fictional visible note", "short-text");
  const hidden = customField("Fictional hidden note", "short-text");
  const readOnly = customField("Fictional read-only note", "short-text");
  const hiddenTask = customField("Fictional hidden task note", "short-text");
  const visibleTask = customField("Fictional visible task note", "short-text");
  const LABELS = [visible, hidden, readOnly, hiddenTask, visibleTask].map(
    (field) => field.label,
  );
  const id = {} as Record<
    | "candidate"
    | "second"
    | "vacancy"
    | "application"
    | "offer"
    | "task"
    | "bucket",
    string
  >;

  /** Fixture setup or inspection as the database owner, outside RLS. */
  async function asOwner<T>(work: () => Promise<T>): Promise<T> {
    await fixture.client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  /** The team's records, record activity, retry keys and bulk items: unchanged by a refusal. */
  const fingerprint = () =>
    asOwner(async () =>
      JSON.stringify(
        (
          await fixture.client.query(
            `SELECT (SELECT json_agg(r ORDER BY r.id) FROM (SELECT id, version, data, legacy_id FROM app.records WHERE team_id = $1) r) AS records,
              (SELECT count(*)::int FROM app.activity WHERE team_id = $1 AND kind <> 'mcp-tool') AS activity,
              (SELECT count(*)::int FROM app.idempotency WHERE team_id = $1) AS keys,
              (SELECT count(*)::int FROM app.bulk_intake_items WHERE team_id = $1) AS items`,
            [owner.teamId],
          )
        ).rows,
      ),
    );
  const signIn = (p: Principal) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: p.teamId, createdAt: new Date() },
    } as never);
  /** One request through a route handler as a signed-in member. */
  async function request(
    p: Principal,
    handler: Handler,
    path: string,
    init: { method?: string; body?: unknown; params?: Row } = {},
  ) {
    signIn(p);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers: {
          origin: ORIGIN,
          "x-team-id": p.teamId,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      { params: Promise.resolve(init.params ?? {}) } as never,
    );
    const text = await response.text();
    return {
      status: response.status,
      text,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text.startsWith("{") ? JSON.parse(text) : null) as any,
    };
  }
  const get = (p: Principal, resource: string, recordId: string) =>
    request(p, getRoute as Handler, `/api/v1/${resource}/${recordId}`, {
      params: { resource, id: recordId },
    });
  const list = (p: Principal, resource: string, query: Row = {}) =>
    request(
      p,
      listRoute as Handler,
      `/api/v1/${resource}?${new URLSearchParams(query as Record<string, string>)}`,
      { params: { resource } },
    );
  const create = (p: Principal, resource: string, body: unknown) =>
    request(p, createRoute as Handler, `/api/v1/${resource}`, {
      method: "POST",
      body,
      params: { resource },
    });
  const patch = (
    p: Principal,
    resource: string,
    recordId: string,
    body: unknown,
  ) =>
    request(p, patchRoute as Handler, `/api/v1/${resource}/${recordId}`, {
      method: "PATCH",
      body,
      params: { resource, id: recordId },
    });
  const exported = (p: Principal, resource: string, query = "") =>
    request(p, exportRoute as Handler, `/api/v1/${resource}/export${query}`, {
      method: "POST",
      params: { resource },
    });
  /** The record as the owner reads it. */
  const stored = (
    resource: Parameters<typeof getRecord>[1],
    recordId: string,
  ) => getRecord(owner, resource, recordId);
  const mcp = async (p: Principal, name: string, args: Row) =>
    (await callTool(
      p,
      TOOLS.find((item) => item.name === name)!,
      args,
    )) as McpResult;
  const mcpData = <T>(result: McpResult) => {
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent.untrustedData).toBe(true);
    expect(result.structuredContent.notice).toEqual(expect.any(String));
    return result.structuredContent.data as T;
  };
  const customOf = (row: { data: unknown }) =>
    ((row.data as Row).customValues ?? {}) as Row;
  /** A configured role published by the company owner and assigned to the member. */
  async function assign(
    p: Principal,
    key: string,
    base: RoleBody,
    fields: RoleBody["fields"],
  ) {
    const role = await createConfigDraft(owner, {
      type: "role",
      key,
      body: {
        ...structuredClone(base),
        name: `Fictional ${key}`,
        fields,
      } as RoleBody,
    });
    await publishConfigVersion(owner, role.versionId);
    await assignMemberRole(
      owner,
      { userId: p.userId, roleObjectId: role.objectId },
      new Headers(),
    );
  }

  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    fixture = await createTestDb();
    pools.data.mockResolvedValue(fixture.db);
    pools.identity.mockResolvedValue(fixture.db);
    const team = "fr-team";
    owner = await seedIdentity(fixture.db, {
      userId: "fr-owner",
      teamId: team,
    });
    const seed = (userId: string, role: "recruiter" | "admin" = "recruiter") =>
      seedIdentity(fixture.db, { userId, teamId: team, role });
    member = await seed("fr-member");
    variant = await seed("fr-variant");
    plain = await seed("fr-plain");
    builtin = await seed("fr-builtin");
    importer = await seed("fr-importer", "admin");
    ownerToken = await seedApiToken(fixture.db, owner);
    memberToken = await seedApiToken(fixture.db, member);
    plainToken = await seedApiToken(fixture.db, plain);
    builtinToken = await seedApiToken(fixture.db, builtin);
    await enforceTestRls(fixture.db);
    await asOwner(async () => {
      await insertKindSchema(
        fixture.client,
        owner.userId,
        kindBody("candidate", [visible, hidden, readOnly]),
      );
      await insertKindSchema(
        fixture.client,
        owner.userId,
        kindBody("task", [hiddenTask, visibleTask]),
      );
    });
    // The fictional redacted recruiter of the spec: hidden offer amount, vacancy title, application
    // stage and two custom fields; read-only candidate phone and one custom field.
    await assign(
      member,
      "redacted-recruiter",
      RECRUITER_ROLE.body as RoleBody,
      {
        candidate: {
          phone: "read",
          customValues: "edit",
          [hidden.key]: "hidden",
          [readOnly.key]: "read",
        },
        offer: { amount: "hidden" },
        vacancy: { title: "hidden" },
        application: { stage: "hidden" },
        task: { [hiddenTask.key]: "hidden" },
      },
    );
    // A variant that hides the candidate contact, name and skills.
    await assign(variant, "redacted-variant", RECRUITER_ROLE.body as RoleBody, {
      candidate: {
        name: "hidden",
        email: "hidden",
        skills: "hidden",
        customValues: "edit",
      },
    });
    await assign(plain, "plain-recruiter", RECRUITER_ROLE.body as RoleBody, {});
    await assign(importer, "redacted-importer", ADMIN_ROLE.body as RoleBody, {
      candidate: { legacyId: "hidden", customValues: "edit" },
    });

    await bootstrapTeam(owner);
    id.bucket = (
      await listRecords(
        owner,
        "buckets",
        new URLSearchParams({ sort: "position" }),
      )
    ).data[0].id;
    id.candidate = (
      await createRecord(owner, "candidates", {
        data: {
          name: "Fictional Redaction Candidate",
          email: "fictional.redaction@example.test",
          phone: "+971 50 123 4567",
          skills: ["Fictional Skill"],
          certifications: ["Fictional Certificate"],
          customValues: {
            [visible.key]: VISIBLE_VALUE,
            [hidden.key]: HIDDEN_VALUE,
            [readOnly.key]: READ_ONLY_VALUE,
          },
        },
      })
    ).id;
    id.second = (
      await createRecord(owner, "candidates", {
        data: {
          name: "Another Fictional Person",
          phone: "+971 50 765 4321",
          email: "fictional.another@example.test",
        },
      })
    ).id;
    id.vacancy = (
      await createRecord(owner, "vacancies", {
        data: {
          title: VACANCY_TITLE,
          status: "Open",
          targetDate: "2020-01-01",
        },
      })
    ).id;
    const application = await createRecord(owner, "applications", {
      candidateId: id.candidate,
      vacancyId: id.vacancy,
      data: { stage: "Sourced" },
    });
    id.application = application.id;
    await updateRecord(owner, "applications", id.application, {
      version: application.version,
      data: { stage: "Screening" },
    });
    id.offer = (
      await createRecord(owner, "offers", {
        applicationId: id.application,
        data: { title: "Fictional redaction offer", amount: AMOUNT },
      })
    ).id;
    id.task = (
      await createRecord(owner, "tasks", {
        bucketId: id.bucket,
        data: {
          title: "Fictional redaction task",
          customValues: {
            [hiddenTask.key]: HIDDEN_TASK_VALUE,
            [visibleTask.key]: "Fictional visible task value",
          },
        },
      })
    ).id;
  });
  beforeEach(() =>
    asOwner(() => fixture.client.exec("DELETE FROM auth.api_rate_limits")),
  );
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("leaves hidden fields out of REST get, list, create, update and bulk responses", async () => {
    // Get and list: no amount, no hidden custom value; the owner sees both.
    const offer = await get(member, "offers", id.offer);
    expect(offer.status).toBe(200);
    expect(Object.hasOwn(offer.body.data.data, "amount")).toBe(false);
    expect((await get(owner, "offers", id.offer)).body.data.data.amount).toBe(
      AMOUNT,
    );
    const candidate = await get(member, "candidates", id.candidate);
    expect(customOf(candidate.body.data)).toEqual({
      [visible.key]: VISIBLE_VALUE,
      [readOnly.key]: READ_ONLY_VALUE,
    });
    expect(candidate.body.data.readOnlyFields).toEqual(["phone"]);
    expect(
      customOf((await get(owner, "candidates", id.candidate)).body.data),
    ).toMatchObject({ [hidden.key]: HIDDEN_VALUE });
    const offers = await list(member, "offers", {
      applicationId: id.application,
    });
    expect(offers.status).toBe(200);
    expect(offers.body.data.length).toBeGreaterThan(0);
    for (const row of offers.body.data)
      expect(Object.hasOwn(row.data, "amount")).toBe(false);
    expect(
      (await list(owner, "offers", { applicationId: id.application })).body
        .data[0].data,
    ).toHaveProperty("amount");
    const candidates = await list(member, "candidates");
    expect(candidates.text).not.toContain(HIDDEN_VALUE);
    expect(candidates.text).toContain(VISIBLE_VALUE);

    // Create and update responses go through the same redaction.
    const created = await create(member, "offers", {
      applicationId: id.application,
      data: { title: "Fictional member offer" },
    });
    expect(created.status).toBe(201);
    expect(Object.hasOwn(created.body.data.data, "amount")).toBe(false);
    expect(
      (
        await create(owner, "offers", {
          applicationId: id.application,
          data: { title: "Fictional owner offer" },
        })
      ).body.data.data,
    ).toHaveProperty("amount", null);
    const current = await stored("candidates", id.candidate);
    const updated = await patch(member, "candidates", id.candidate, {
      version: current.version,
      data: { jobTitle: "Fictional analyst" },
    });
    expect(updated.status).toBe(200);
    expect(customOf(updated.body.data)).not.toHaveProperty(hidden.key);
    expect(customOf(updated.body.data)).toHaveProperty(visible.key);
    expect(customOf(await stored("candidates", id.candidate))).toMatchObject({
      [hidden.key]: HIDDEN_VALUE,
    });

    // Bulk applications: the hidden stage is left out of every created row.
    const make = async (title: string) =>
      (await createRecord(owner, "vacancies", { data: { title } })).id;
    const bulk = await request(
      member,
      bulkRoute as Handler,
      "/api/v1/applications/bulk",
      {
        method: "POST",
        body: {
          candidateIds: [id.second],
          vacancyId: await make("Fictional bulk vacancy"),
        },
      },
    );
    expect(bulk.status).toBe(200);
    expect(bulk.body.created).toBe(1);
    expect(Object.hasOwn(bulk.body.data[0].data, "stage")).toBe(false);
    expect(bulk.body.data[0].vacancyLabel).toBe("Untitled vacancy");
    const ownerBulk = await request(
      owner,
      bulkRoute as Handler,
      "/api/v1/applications/bulk",
      {
        method: "POST",
        body: {
          candidateIds: [id.second],
          vacancyId: await make("Fictional owner bulk vacancy"),
        },
      },
    );
    expect(ownerBulk.body.data[0].data.stage).toBe("Sourced");
  });

  it("exports only visible columns, custom fields headed by their label", async () => {
    const offers = await exported(member, "offers");
    expect(offers.status).toBe(200);
    expect(offers.text).not.toContain('"Amount"');
    expect(offers.text).not.toContain(AMOUNT);
    const ownerOffers = await exported(owner, "offers");
    expect(ownerOffers.text).toContain('"Amount"');
    expect(ownerOffers.text).toContain(AMOUNT);
    const candidates = await exported(member, "candidates");
    expect(candidates.status).toBe(200);
    for (const text of [visible.label, readOnly.label, VISIBLE_VALUE])
      expect(candidates.text).toContain(text);
    for (const text of [hidden.label, HIDDEN_VALUE])
      expect(candidates.text).not.toContain(text);
    const ownerCandidates = await exported(owner, "candidates");
    for (const text of [hidden.label, HIDDEN_VALUE])
      expect(ownerCandidates.text).toContain(text);
  });

  it("never matches a search term on a hidden system or custom value", async () => {
    const total = async (p: Principal, resource: string, search: string) =>
      (await list(p, resource, { search })).body.pagination.total;
    expect(await total(member, "offers", AMOUNT)).toBe(0);
    expect(await total(owner, "offers", AMOUNT)).toBe(1);
    expect(await total(member, "candidates", `"${HIDDEN_VALUE}"`)).toBe(0);
    expect(await total(owner, "candidates", `"${HIDDEN_VALUE}"`)).toBe(1);
    expect(await total(member, "candidates", `"${VISIBLE_VALUE}"`)).toBe(1);
    const search = async (p: Principal, q: string) =>
      (
        await request(
          p,
          searchRoute as Handler,
          `/api/v1/search?${new URLSearchParams({ q })}`,
        )
      ).body;
    expect((await search(member, `"${HIDDEN_VALUE}"`)).total).toBe(0);
    const ownerFound = await search(owner, `"${HIDDEN_VALUE}"`);
    expect(ownerFound.data.map((row: Row) => row.id)).toContain(id.candidate);
    const memberFound = await search(member, `"${VISIBLE_VALUE}"`);
    expect(memberFound.data.map((row: Row) => row.id)).toContain(id.candidate);
    // The vacancy title is hidden too, so an application never matches on it.
    expect((await search(member, `"${VACANCY_TITLE}"`)).total).toBe(0);
  });

  it("titles notifications only from visible fields", async () => {
    const reminder = async (p: Principal) => {
      const result = await notifications(p);
      return {
        text: JSON.stringify(result),
        row: result.data.find((row) =>
          row.key.startsWith(`vacancy:${id.vacancy}:`),
        ),
      };
    };
    const hiddenTitle = await reminder(member);
    expect(hiddenTitle.row?.title).toBe("Vacancy target date");
    for (const text of [VACANCY_TITLE, AMOUNT, HIDDEN_VALUE])
      expect(hiddenTitle.text).not.toContain(text);
    expect((await reminder(owner)).row?.title).toBe(
      `Vacancy target date: ${VACANCY_TITLE}`,
    );
  });

  it("drops activity metadata that carries a hidden field's value", async () => {
    const history = async (p: Principal) =>
      (
        await listActivity(
          p,
          new URLSearchParams({ recordId: id.application, pageSize: "100" }),
        )
      ).data;
    const ownerRows = await history(owner);
    expect(ownerRows.some((row) => row.metadata.toStage === "Screening")).toBe(
      true,
    );
    const memberRows = await history(member);
    expect(memberRows.map((row) => row.id)).toEqual(
      ownerRows.map((row) => row.id),
    );
    for (const row of memberRows) {
      expect(Object.hasOwn(row.metadata, "fromStage")).toBe(false);
      expect(Object.hasOwn(row.metadata, "toStage")).toBe(false);
    }
    expect(JSON.stringify(memberRows)).not.toContain(AMOUNT);
  });

  it("labels applications only from visible fields", async () => {
    const application = (await get(member, "applications", id.application)).body
      .data;
    expect(application.vacancyLabel).toBe("Untitled vacancy");
    expect(application.candidateLabel).toBe("Fictional Redaction Candidate");
    expect(application.label).toBe("Fictional Redaction Candidate");
    expect(JSON.stringify(application)).not.toContain(VACANCY_TITLE);
    const listed = await list(member, "applications", {
      vacancyId: id.vacancy,
    });
    expect(listed.body.data[0].vacancyLabel).toBe("Untitled vacancy");
    expect(listed.text).not.toContain(VACANCY_TITLE);
    const ownerApplication = (await get(owner, "applications", id.application))
      .body.data;
    expect(ownerApplication.vacancyLabel).toBe(VACANCY_TITLE);
  });

  it("groups analytics and the overview only over visible fields", async () => {
    const charts = await analytics(member, new URLSearchParams());
    expect(charts.stages).toEqual([]);
    expect((await analytics(owner, new URLSearchParams())).stages).not.toEqual(
      [],
    );
    const home = await overview(member);
    expect(home.stages).toEqual([]);
    expect((await overview(owner)).stages).not.toEqual([]);
    for (const text of [AMOUNT, HIDDEN_VALUE, VACANCY_TITLE])
      expect(JSON.stringify([charts, home])).not.toContain(text);
  });

  it("leaves hidden fields out of MCP results inside the untrusted-data wrapper", async () => {
    const offers = mcpData<Row[]>(
      await mcp(memberToken, "list_offers", { applicationId: id.application }),
    );
    expect(offers.length).toBeGreaterThan(0);
    for (const row of offers) expect(Object.hasOwn(row, "amount")).toBe(false);
    const ownerOffers = mcpData<Row[]>(
      await mcp(ownerToken, "list_offers", { applicationId: id.application }),
    );
    expect(ownerOffers.map((row) => row.amount)).toContain(AMOUNT);
    const tasks = mcpData<Row[]>(
      await mcp(memberToken, "list_tasks", { bucketId: id.bucket }),
    );
    const task = tasks.find((row) => row.id === id.task)!;
    expect(task.customValues).toEqual({
      [visibleTask.key]: "Fictional visible task value",
    });
    const ownerTask = mcpData<Row[]>(
      await mcp(ownerToken, "list_tasks", { bucketId: id.bucket }),
    ).find((row) => row.id === id.task)!;
    expect(ownerTask.customValues).toMatchObject({
      [hiddenTask.key]: HIDDEN_TASK_VALUE,
    });
  });

  it("refuses a filter or sort on a hidden field and sorts a hidden default by createdAt", async () => {
    const stage = "Your role cannot see stage, so you cannot filter by it.";
    const listed = await list(member, "applications", { stage: "Applied" });
    expect(listed.status).toBe(400);
    expect(listed.body.error).toMatchObject({
      code: "invalid_query",
      message: stage,
    });
    const file = await exported(member, "applications", "?stage=Applied");
    expect(file.status).toBe(400);
    expect(file.body.error).toMatchObject({
      code: "invalid_query",
      message: stage,
    });
    // Refused even beside another invalid filter.
    expect(
      (
        await list(member, "applications", {
          stage: "Applied",
          minYearsExperience: "x",
        })
      ).body.error.message,
    ).toBe(stage);
    const sorted = await list(member, "vacancies", { sort: "title" });
    expect(sorted.status).toBe(400);
    expect(sorted.body.error).toMatchObject({
      code: "invalid_query",
      message: "Your role cannot see title, so you cannot sort by it.",
    });
    for (const [resource, query] of [
      ["applications", { stage: "Applied" }],
      ["vacancies", { sort: "title" }],
    ] as const)
      expect((await list(owner, resource, query)).status).toBe(200);
    expect(
      (await exported(owner, "applications", "?stage=Applied")).status,
    ).toBe(200);
    // The variant hides candidate names, the candidates' default sort.
    const byDefault = await list(variant, "candidates");
    expect(byDefault.status).toBe(200);
    const byCreation = await list(owner, "candidates", { sort: "createdAt" });
    expect(byDefault.body.data.map((row: Row) => row.id)).toEqual(
      byCreation.body.data.map((row: Row) => row.id),
    );
    expect(
      (await list(variant, "candidates", { sort: "name" })).body.error,
    ).toMatchObject({
      code: "invalid_query",
      message: "Your role cannot see name, so you cannot sort by it.",
    });
  });

  it("refuses a REST, bulk, import or MCP write naming a hidden or read-only field and changes nothing", async () => {
    const before = await fingerprint();
    const offer = await stored("offers", id.offer);
    const candidate = await stored("candidates", id.candidate);
    const refused = async (
      call: () => Promise<{ status: number; body: { error: Row } }>,
      key: string,
    ) => {
      const response = await call();
      expect(response.status, key).toBe(403);
      expect(response.body.error, key).toMatchObject({
        code: "field_forbidden",
        message: `Your role cannot change ${key}.`,
      });
    };
    await refused(
      () =>
        create(member, "offers", {
          applicationId: id.application,
          data: { title: "Fictional refused offer", amount: "5" },
        }),
      "amount",
    );
    await refused(
      () =>
        patch(member, "offers", id.offer, {
          version: offer.version,
          data: { amount: "6" },
        }),
      "amount",
    );
    await refused(
      () =>
        create(member, "candidates", {
          data: { name: "Fictional Refused Person", phone: "+971 50 000 0091" },
        }),
      "phone",
    );
    for (const [data, key] of [
      [{ phone: "+971 50 000 0092" }, "phone"],
      [{ customValues: { [hidden.key]: "Fictional overwrite" } }, hidden.key],
      [
        { customValues: { [readOnly.key]: "Fictional overwrite" } },
        readOnly.key,
      ],
    ] as const)
      await refused(
        () =>
          patch(member, "candidates", id.candidate, {
            version: candidate.version,
            data,
          }),
        key,
      );
    await refused(
      () =>
        create(member, "candidates", {
          data: {
            name: "Fictional Refused Custom Person",
            customValues: { [hidden.key]: "Fictional hidden create" },
          },
        }),
      hidden.key,
    );
    await refused(
      () =>
        request(member, bulkRoute as Handler, "/api/v1/applications/bulk", {
          method: "POST",
          body: {
            candidateIds: [id.candidate],
            vacancyId: id.vacancy,
            stage: "Screening",
          },
        }),
      "stage",
    );
    const batchId = randomUUID();
    const itemId = randomUUID();
    await refused(
      () =>
        request(
          member,
          bulkItemRoute as Handler,
          `/api/v1/cvs/bulk-batches/${batchId}/items/${itemId}`,
          {
            method: "POST",
            params: { batchId, itemId },
            body: {
              file: {
                originalName: "fictional.pdf",
                mimeType: "application/pdf",
                sizeBytes: 100,
              },
              data: {
                name: "Fictional Bulk Person",
                phone: "+971 50 000 0093",
              },
              factsReviewed: true,
              duplicatesReviewed: true,
            },
          },
        ),
      "phone",
    );
    await refused(
      () =>
        create(importer, "candidates", {
          data: { name: "Fictional Imported Person" },
          legacyId: "FICTIONAL-091-1",
        }),
      "legacyId",
    );
    const mcpRefused = async (name: string, args: Row) => {
      const result = await mcp(memberToken, name, args);
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent.error, name).toEqual({
        code: "field_forbidden",
        message: "Your role cannot change amount.",
      });
    };
    await mcpRefused("create_offer", {
      idempotencyKey: `fictional-${randomUUID()}`,
      applicationId: id.application,
      title: "Fictional MCP refused offer",
      amount: "7",
    });
    await mcpRefused("update_offer", {
      id: id.offer,
      version: offer.version,
      amount: "8",
    });
    expect(await fingerprint()).toBe(before);

    // A default is never a field the caller named: the same writes without the field succeed.
    expect(
      mcpData<Row>(
        await mcp(memberToken, "create_offer", {
          idempotencyKey: `fictional-${randomUUID()}`,
          applicationId: id.application,
          title: "Fictional MCP offer",
        }),
      ).id,
    ).toEqual(expect.any(String));
    expect(
      mcpData<Row>(
        await mcp(memberToken, "create_candidate", {
          idempotencyKey: `fictional-${randomUUID()}`,
          name: "Fictional MCP Person",
        }),
      ).id,
    ).toEqual(expect.any(String));
    const bulkItem = randomUUID();
    const bulkCreated = await request(
      member,
      bulkItemRoute as Handler,
      `/api/v1/cvs/bulk-batches/${batchId}/items/${bulkItem}`,
      {
        method: "POST",
        params: { batchId, itemId: bulkItem },
        body: {
          file: {
            originalName: "fictional.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
          },
          data: { name: "Fictional Bulk Person" },
          factsReviewed: true,
          duplicatesReviewed: true,
        },
      },
    );
    expect(bulkCreated.status).toBe(201);
    expect(
      (await stored("candidates", bulkCreated.body.data.candidateId)).data,
    ).toMatchObject({
      name: "Fictional Bulk Person",
      phone: "",
      reviewStatus: "Reviewed",
    });
  });

  it("keeps the stored hidden and read-only values a write leaves out", async () => {
    const before = await stored("candidates", id.candidate);
    const kept = {
      phone: (before.data as Row).phone,
      [hidden.key]: customOf(before)[hidden.key],
      [readOnly.key]: customOf(before)[readOnly.key],
    };
    expect(kept).toEqual({
      phone: "+971 50 123 4567",
      [hidden.key]: HIDDEN_VALUE,
      [readOnly.key]: READ_ONLY_VALUE,
    });
    const omitted = await patch(member, "candidates", id.candidate, {
      version: before.version,
      data: { employer: "Fictional Employer" },
    });
    expect(omitted.status).toBe(200);
    const partial = await patch(member, "candidates", id.candidate, {
      version: omitted.body.data.version,
      data: { customValues: { [visible.key]: "Fictional changed value" } },
    });
    expect(partial.status).toBe(200);
    const after = await stored("candidates", id.candidate);
    expect(after.data).toMatchObject({
      phone: kept.phone,
      employer: "Fictional Employer",
    });
    expect(customOf(after)).toEqual({
      [visible.key]: "Fictional changed value",
      [hidden.key]: HIDDEN_VALUE,
      [readOnly.key]: READ_ONLY_VALUE,
    });

    // MCP update_task with a partial map keeps the hidden task value and never names it.
    const task = await stored("tasks", id.task);
    mcpData(
      await mcp(memberToken, "update_task", {
        id: id.task,
        version: task.version,
        customValues: { [visibleTask.key]: "Fictional changed task value" },
      }),
    );
    expect(customOf(await stored("tasks", id.task))).toMatchObject({
      [hiddenTask.key]: HIDDEN_TASK_VALUE,
      [visibleTask.key]: "Fictional changed task value",
    });
    const refused = await mcp(memberToken, "update_task", {
      id: id.task,
      version: task.version + 1,
      customValues: { [hiddenTask.key]: "Fictional overwrite" },
    });
    expect(refused.structuredContent.error).toEqual({
      code: "field_forbidden",
      message: `Your role cannot change ${hiddenTask.key}.`,
    });
  });

  it("checks duplicates and suggestions against the role's field rules", async () => {
    const duplicates = (p: Principal, body: Row) =>
      request(p, duplicatesRoute as Handler, "/api/v1/candidates/duplicates", {
        method: "POST",
        body,
      });
    const byEmail = await duplicates(variant, {
      email: "fictional.redaction@example.test",
    });
    expect(byEmail.status).toBe(400);
    expect(byEmail.body.error).toMatchObject({
      code: "invalid_query",
      message: "Your role cannot see email, so you cannot filter by it.",
    });
    const byPhone = await duplicates(variant, { phone: "+971 50 123 4567" });
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.data).toEqual([
      { id: id.candidate, phone: "+971 50 123 4567", matches: ["phone"] },
    ]);
    expect(
      (await duplicates(owner, { phone: "+971 50 123 4567" })).body.data,
    ).toEqual([
      {
        id: id.candidate,
        name: "Fictional Redaction Candidate",
        email: "fictional.redaction@example.test",
        phone: "+971 50 123 4567",
        matches: ["phone"],
      },
    ]);
    const suggestions = await request(
      variant,
      suggestionsRoute as Handler,
      "/api/v1/candidates/suggestions",
    );
    expect(suggestions.body.data).toEqual({
      skills: [],
      certifications: ["Fictional Certificate"],
    });
    expect(
      (
        await request(
          owner,
          suggestionsRoute as Handler,
          "/api/v1/candidates/suggestions",
        )
      ).body.data.skills,
    ).toEqual(["Fictional Skill"]);
  });

  it("answers a role with no field rules exactly as the built-in recruiter", async () => {
    const same = async (call: (p: Principal) => Promise<unknown>) => {
      const configured = JSON.stringify(await call(plain));
      expect(configured).toBe(JSON.stringify(await call(builtin)));
      return configured;
    };
    const rest = async (p: Principal) => [
      (await get(p, "candidates", id.candidate)).text,
      (await get(p, "offers", id.offer)).text,
      (await list(p, "candidates")).text,
      (await list(p, "applications")).text,
    ];
    const text = await same(rest);
    expect(text).toContain(HIDDEN_VALUE);
    expect(text).toContain(AMOUNT);
    const tool = (name: string, args: Row) => async (p: Principal) =>
      (await mcp(p === plain ? plainToken : builtinToken, name, args))
        .structuredContent;
    await same(tool("search_candidates", { query: "Fictional" }));
    await same(tool("get_candidate", { id: id.candidate }));
    await same(tool("list_offers", { applicationId: id.application }));
    await same(tool("list_tasks", { bucketId: id.bucket }));
  });

  // R2b-09 (job 094): the published kind schema's sensitive marks also leave fields out of MCP.
  it("leaves the fields a published kind schema marks sensitive out of MCP results only (R2b-09)", async () => {
    const mcpCandidate = async () =>
      mcpData<Row>(
        await mcp(ownerToken, "get_candidate", { id: id.candidate }),
      );
    const mcpTask = async () =>
      mcpData<Row[]>(
        await mcp(ownerToken, "list_tasks", { bucketId: id.bucket }),
      ).find((row) => row.id === id.task)!;
    /** Publishes both kind schemas again, with or without the marks. */
    const publish = (marked: boolean) =>
      asOwner(async () => {
        const candidate = kindBody("candidate", [visible, hidden, readOnly]);
        Object.assign(
          candidate.fields.find((field) => field.key === "certifications")!,
          { sensitive: marked },
        );
        await insertKindSchema(fixture.client, owner.userId, candidate);
        await insertKindSchema(
          fixture.client,
          owner.userId,
          kindBody("task", [
            hiddenTask,
            { ...visibleTask, ...(marked ? { sensitive: true } : {}) },
          ]),
        );
      });
    const shown = async () => {
      const candidate = await mcpCandidate();
      const task = await mcpTask();
      return [
        Object.hasOwn(candidate.facts as Row, "certifications"),
        // A sensitive custom field leaves the task's whole custom map out of MCP results.
        Object.hasOwn((task.customValues ?? {}) as Row, visibleTask.key),
      ];
    };
    expect(await shown()).toEqual([true, true]);
    const taskValue = () =>
      get(owner, "tasks", id.task).then(
        (task) => customOf(task.body.data)[visibleTask.key],
      );
    const stored = await taskValue();
    expect(stored).toEqual(expect.any(String));
    await publish(true);
    expect(await shown()).toEqual([false, false]);
    // An MCP update of the task's custom values keeps the sensitive value it cannot see.
    const { version } = await mcpTask();
    mcpData(
      await mcp(ownerToken, "update_task", {
        id: id.task,
        version,
        customValues: { [hiddenTask.key]: HIDDEN_TASK_VALUE },
      }),
    );
    // REST still returns both to the owner.
    expect(
      (await get(owner, "candidates", id.candidate)).body.data.data
        .certifications,
    ).toEqual(["Fictional Certificate"]);
    expect(await taskValue()).toBe(stored);
    await publish(false);
    expect(await shown()).toEqual([true, true]);
  });

  it("serves one static OpenAPI document with no label of the published kind schemas", async () => {
    const text = await (await openapiRoute()).text();
    expect(text).toContain("field_forbidden");
    for (const label of LABELS) expect(text).not.toContain(label);
  });
});
