import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: vi.fn() }));
import { getVerifiedSession } from "@/lib/auth-session";
import { authenticateApiToken } from "@/lib/api-tokens";
import { records } from "@/db/schema";
import { withTeam } from "@/lib/db-team";
import { createRecord, getRecord, updateRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import {
  createRecordSchemas,
  updateRecordSchemas,
  type RecordDto,
} from "@/domain/records";
import { recordMutation } from "@/components/workspace/mutation";
import {
  GET as listRoute,
  POST as createRoute,
} from "@/app/api/v1/[resource]/route";
import {
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/v1/[resource]/[id]/route";
import {
  buildPlan,
  type MigrationPlan,
  type PlannedRecord,
} from "../scripts/legacy/plan";
import { applyPlan } from "../scripts/legacy/apply";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

const origin = "http://localhost:3000";

/** Send a request to the real generic record route modules. */
function dispatch(request: Request): Promise<Response> {
  const [, , , resource, id] = new URL(request.url).pathname.split("/");
  if (id === undefined) {
    const context = { params: Promise.resolve({ resource }) };
    return request.method === "GET"
      ? listRoute(request, context)
      : createRoute(request, context);
  }
  const context = { params: Promise.resolve({ resource, id }) };
  return request.method === "GET"
    ? getRoute(request, context)
    : patchRoute(request, context);
}
function send(
  via: "session" | "token",
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
) {
  return dispatch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(via === "token"
          ? { authorization: "Bearer fictional-entry-point-token" }
          : { origin }),
      },
      body: JSON.stringify(body),
    }),
  );
}
async function errorCode(response: Response) {
  return { status: response.status, code: (await response.json()).error.code };
}
function plan(records: PlannedRecord[]): MigrationPlan {
  return {
    formatVersion: 1,
    records,
    sources: [],
    states: [],
    notificationReads: [],
    issues: [],
    stats: {},
    asOf: "",
  };
}

describe("UI, API and importer reject the same invalid writes", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  const importer = (onPatch?: () => Promise<void>) => ({
    apiUrl: origin,
    teamId: owner.teamId,
    token: "fictional-import-token",
    updateExisting: true,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") await onPatch?.();
      return dispatch(
        new Request(String(input), {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        }),
      );
    }) as typeof fetch,
  });
  const total = async (kind: string, condition = sql`true`) =>
    (
      await withTeam(owner, (tx) =>
        tx
          .select({ total: count() })
          .from(records)
          .where(
            and(
              eq(records.teamId, owner.teamId),
              eq(records.kind, kind),
              condition,
            ),
          ),
      )
    )[0].total;

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "entry-owner",
      teamId: "entry-team",
    });
    await enforceTestRls(fixture.db);
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: owner.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: owner.teamId },
    } as Awaited<ReturnType<typeof getVerifiedSession>>);
    vi.mocked(authenticateApiToken).mockResolvedValue(
      await seedApiToken(fixture.db, owner),
    );
  });
  afterAll(async () => fixture?.close());

  it("rejects an invalid candidate email everywhere and creates nothing", async () => {
    const values = { name: "Fictional Invalid Email", email: "invalid-email" };
    const invalid = sql`${records.data}->>'email' = 'invalid-email'`;
    const ui = createRecordSchemas.candidate.safeParse(
      recordMutation("candidates", values, {}),
    );
    expect(ui.success).toBe(false);
    expect(ui.error?.issues.map((issue) => issue.path.join("."))).toContain(
      "data.email",
    );
    expect(
      await errorCode(
        await send("token", "POST", "/api/v1/candidates", { data: values }),
      ),
    ).toEqual({ status: 400, code: "invalid_input" });
    const dryRun = buildPlan({
      workbooks: {
        "Resume_Master.xlsx": {
          Master: [
            ["Title"],
            [],
            ["As of", "2026-10-01"],
            [],
            [],
            ["Candidate ID", "Candidate Full Name", "Email"],
            ["c_invalid", values.name, values.email],
          ],
          "File Inventory": [["Source ID", "Candidate IDs"]],
        },
      },
      states: [],
      recovered: {},
      issues: [],
    });
    expect(dryRun.issues).toContainEqual(
      expect.objectContaining({
        code: "INVALID_DATA",
        location: expect.stringMatching(/\/email$/),
      }),
    );
    const applied = await applyPlan(
      plan([
        {
          resource: "candidates",
          legacyId: "c_invalid",
          data: values,
          refs: {},
          archived: false,
          importMeta: { workbook: "Fictional.xlsx" },
        },
      ]),
      importer(),
    );
    expect(applied.created).toBe(0);
    expect(applied.errors).toEqual([
      expect.objectContaining({
        location: "candidates:c_invalid",
        code: "invalid_input",
      }),
    ]);
    expect(await total("candidate", invalid)).toBe(0);
  });

  it("answers an unknown custom field on the default schema in the error shape with a correlation id (R2b-04)", async () => {
    const name = "Fictional Unknown Custom Value";
    const response = await send("token", "POST", "/api/v1/candidates", {
      data: { name, customValues: { [randomUUID()]: "x" } },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "unknown_custom_field",
        message: "A custom field is not available in this team.",
        correlationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      },
    });
    expect(response.headers.get("x-correlation-id")).toBe(
      body.error.correlationId,
    );
    expect(
      await total("candidate", sql`${records.data}->>'name' = ${name}`),
    ).toBe(0);
  });

  it("rejects an archived parent vacancy everywhere and creates no application", async () => {
    const person = await createRecord(owner, "candidates", {
      data: { name: "Fictional Parent Person" },
      legacyId: "c_parent",
      importMeta: { workbook: "Fictional.xlsx" },
    });
    const job = await createRecord(owner, "vacancies", {
      data: { title: "Fictional archived vacancy", status: "Closed" },
      legacyId: "v_archived",
      importMeta: { workbook: "Fictional.xlsx" },
    });
    await updateRecord(owner, "vacancies", job.id, {
      version: 1,
      archived: true,
    });
    const refs = { candidateId: person.id, vacancyId: job.id };
    const mutation = recordMutation(
      "applications",
      { stage: "Screening" },
      refs,
    );
    expect(createRecordSchemas.application.safeParse(mutation).success).toBe(
      true,
    );
    expect(
      await errorCode(
        await send("session", "POST", "/api/v1/applications", mutation),
      ),
    ).toEqual({ status: 400, code: "archived_reference" });
    expect(
      await errorCode(
        await send("token", "POST", "/api/v1/applications", {
          ...refs,
          data: { stage: "Screening" },
        }),
      ),
    ).toEqual({ status: 400, code: "archived_reference" });
    const applied = await applyPlan(
      plan([
        {
          resource: "applications",
          legacyId: "a_archived_parent",
          data: { stage: "Screening" },
          refs: {
            candidateId: { resource: "candidates", legacyId: "c_parent" },
            vacancyId: { resource: "vacancies", legacyId: "v_archived" },
          },
          archived: false,
          importMeta: { workbook: "Fictional.xlsx" },
        },
      ]),
      importer(),
    );
    expect(applied.created).toBe(0);
    expect(applied.errors).toEqual([
      expect.objectContaining({
        location: "applications:a_archived_parent",
        code: "archived_reference",
      }),
    ]);
    expect(await total("application", eq(records.vacancyId, job.id))).toBe(0);
  });

  it("rejects a stale version everywhere and keeps the newer stored data", async () => {
    const created = await createRecord(owner, "candidates", {
      data: { name: "Fictional Stale Person", jobTitle: "Original title" },
      legacyId: "c_stale",
      importMeta: { workbook: "Fictional.xlsx" },
    });
    const stale: RecordDto = await getRecord(owner, "candidates", created.id);
    const concurrent = await updateRecord(owner, "candidates", created.id, {
      version: stale.version,
      data: { jobTitle: "Concurrent title" },
    });
    const ui = recordMutation(
      "candidates",
      { ...stale.data, jobTitle: "Stale UI title" },
      {},
      stale,
    );
    expect(updateRecordSchemas.candidate.safeParse(ui).success).toBe(true);
    expect(
      await errorCode(
        await send("session", "PATCH", `/api/v1/candidates/${created.id}`, ui),
      ),
    ).toEqual({ status: 409, code: "version_conflict" });
    expect(
      await errorCode(
        await send("token", "PATCH", `/api/v1/candidates/${created.id}`, {
          version: stale.version,
          data: { jobTitle: "Stale API title" },
        }),
      ),
    ).toEqual({ status: 409, code: "version_conflict" });
    let latest = concurrent;
    const applied = await applyPlan(
      plan([
        {
          resource: "candidates",
          legacyId: "c_stale",
          data: { ...stale.data, jobTitle: "Stale importer title" },
          refs: {},
          archived: false,
          importMeta: { workbook: "Fictional.xlsx" },
        },
      ]),
      importer(async () => {
        // Another writer saves between the importer's enumeration and its PATCH.
        latest = await updateRecord(owner, "candidates", created.id, {
          version: latest.version,
          data: { jobTitle: "Concurrent importer-era title" },
        });
      }),
    );
    expect(applied.updated).toBe(0);
    expect(applied.errors).toEqual([
      expect.objectContaining({
        location: "candidates:c_stale",
        code: "version_conflict",
      }),
    ]);
    const stored = await getRecord(owner, "candidates", created.id);
    expect(stored.version).toBe(latest.version);
    expect(stored.data).toEqual(latest.data);
    expect(stored.data).toMatchObject({
      jobTitle: "Concurrent importer-era title",
    });
  });
});
