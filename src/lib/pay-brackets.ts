import { DrizzleQueryError, sql } from "drizzle-orm";
import { z } from "zod";
import type { TeamTx } from "@/db";
import { gradeCode } from "@/domain/config";
import { mayWriteConfig } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { jobArchitectureFor } from "@/lib/job-architecture";
import { teamArchived } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

/** Pay period and coverage are stored on each version and shown with every bracket (D23). */
export const PAY_PERIODS = ["monthly", "annual"] as const;
export const BRACKET_COVERS = [
  "basic",
  "basic-housing-transport",
  "total-cash",
] as const;
/** AED fils, at most AED 1,000,000,000 like an offer amount; the database checks the same bound. */
const fils = z.number().int().min(1).max(100_000_000_000);

export const salaryBracketInput = z
  .object({
    payPeriod: z.enum(PAY_PERIODS).default("monthly"),
    covers: z.enum(BRACKET_COVERS).default("basic"),
    effectiveFrom: z.iso.date(),
    brackets: z
      .array(
        z
          .object({
            gradeCode,
            minimumFils: fils,
            midpointFils: fils,
            maximumFils: fils,
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type SalaryBracketInput = z.input<typeof salaryBracketInput>;

export type SalaryBracket = {
  gradeCode: string;
  minimumFils: number;
  midpointFils: number;
  maximumFils: number;
};
export type SalaryBracketVersion = {
  versionId: string;
  number: number | null;
  state: "draft" | "published" | "retired";
  payPeriod: (typeof PAY_PERIODS)[number];
  covers: (typeof BRACKET_COVERS)[number];
  effectiveFrom: string;
  createdAt: string;
  publishedAt: string | null;
  brackets: SalaryBracket[];
};

// No message lists a figure or a grade.
const planAccessRequired = () =>
  new ApiError(
    403,
    "plan_access_required",
    "Salary brackets need Plan & pay access, which only a company owner gives.",
  );
const configForbidden = () =>
  new ApiError(
    403,
    "config_forbidden",
    "You do not have company authority to change this configuration.",
  );
const notFound = () =>
  new ApiError(404, "not_found", "Salary bracket version not found.");
const outOfOrder = () =>
  new ApiError(
    400,
    "invalid_input",
    "The minimum must be at most the midpoint, and the midpoint at most the maximum.",
  );
const gradesMismatch = () =>
  new ApiError(
    400,
    "invalid_input",
    "brackets must hold exactly one bracket for each grade of the published job architecture.",
  );
const versionPublished = () =>
  new ApiError(
    409,
    "bracket_version_published",
    "A published salary bracket version cannot be changed. Create a new draft instead.",
  );

/** One withTeam transaction; the database stays authoritative and its refusals map to API errors. */
async function inBrackets<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown; constraint?: unknown } | undefined;
    if (cause?.code === "42501") throw planAccessRequired();
    if (cause?.code === "RQ007") throw versionPublished();
    if (
      cause?.code === "23514" &&
      cause.constraint === "salary_brackets_order_check"
    )
      throw outOfOrder();
    throw error;
  }
}

/** Every bracket in order, checked before any write; the database checks it again. */
function parseInput(input: SalaryBracketInput) {
  const parsed = salaryBracketInput.parse(input);
  if (
    parsed.brackets.some(
      (b) => b.minimumFils > b.midpointFils || b.midpointFils > b.maximumFils,
    )
  )
    throw outOfOrder();
  return parsed;
}

/** Exactly the expected codes, each once. */
function sameGrades(codes: string[], expected: string[]) {
  const held = new Set(codes);
  return (
    held.size === codes.length &&
    codes.length === expected.length &&
    expected.every((code) => held.has(code))
  );
}

/**
 * tenant_context.allows_plan for write, which the policies also apply, then the organisation
 * authority of allows_workspace from the access state. An archived team stores no plans:write, so
 * it is refused as archived.
 */
async function requireWriter(tx: TeamTx, p: Principal, access: TenantAccess) {
  const [{ allowed }] = (
    await tx.execute<{ allowed: boolean }>(
      sql`select tenant_context.allows_plan(${access.workspaceId}::uuid, 'write') as allowed`,
    )
  ).rows;
  if (!allowed)
    throw access.teamArchived ? teamArchived() : planAccessRequired();
  if (!mayWriteConfig(p, access, "job-architecture")) throw configForbidden();
}

/** The version with its brackets in code-point order of grade code; null for none. */
const versionJson =
  sql.raw(`jsonb_build_object('versionId', v.id, 'number', v.number, 'state', v.state,
  'payPeriod', v.pay_period, 'covers', v.covers, 'effectiveFrom', v.effective_from, 'createdAt', v.created_at,
  'publishedAt', v.published_at, 'brackets', coalesce((select jsonb_agg(jsonb_build_object('gradeCode', b.grade_code,
    'minimumFils', b.minimum_fils, 'midpointFils', b.midpoint_fils, 'maximumFils', b.maximum_fils)
    order by b.grade_code collate "C") from app.salary_brackets b where b.version_id = v.id), '[]'::jsonb))`);

/** A version of the context's workspace that the context can read, or null. */
async function readVersion(
  tx: TeamTx,
  access: TenantAccess,
  versionId: string,
): Promise<SalaryBracketVersion | null> {
  const { rows } = await tx.execute<{ version: SalaryBracketVersion }>(
    sql`select ${versionJson} as version from app.salary_bracket_versions v where v.id = ${versionId}::uuid and v.workspace_id = ${access.workspaceId}::uuid`,
  );
  return rows[0]?.version ?? null;
}

/** The grade codes of the published job architecture; none without one. */
const publishedGrades = (access: TenantAccess) =>
  jobArchitectureFor(access)?.body.grades.map((grade) => grade.code) ?? [];

/**
 * The highest-numbered published version and the newest draft, each null when there is none. Only
 * a session holding Plan & pay access and plans:read reads them, checked in the same statement.
 */
export async function getSalaryBrackets(p: Principal): Promise<{
  current: SalaryBracketVersion | null;
  draft: SalaryBracketVersion | null;
}> {
  return inBrackets(p, async (tx, access) => {
    const [row] = (
      await tx.execute<{
        allowed: boolean;
        current: SalaryBracketVersion | null;
        draft: SalaryBracketVersion | null;
      }>(
        sql`select tenant_context.allows_plan(${access.workspaceId}::uuid, 'read') as allowed, (select ${versionJson} from app.salary_bracket_versions v where v.workspace_id = ${access.workspaceId}::uuid and v.state = 'published' order by v.number desc limit 1) as current, (select ${versionJson} from app.salary_bracket_versions v where v.workspace_id = ${access.workspaceId}::uuid and v.state = 'draft' order by v.created_at desc, v.id desc limit 1) as draft`,
      )
    ).rows;
    if (!row.allowed) throw planAccessRequired();
    return { current: row.current, draft: row.draft };
  });
}

/**
 * A new draft with one bracket for each grade of the published job architecture. Several drafts may
 * exist; each is published on its own.
 */
export async function createSalaryBracketDraft(
  p: Principal,
  input: SalaryBracketInput,
): Promise<SalaryBracketVersion> {
  const parsed = parseInput(input);
  return inBrackets(p, async (tx, access) => {
    await requireWriter(tx, p, access);
    const grades = publishedGrades(access);
    if (!grades.length)
      throw new ApiError(
        409,
        "job_grades_required",
        "Publish a job architecture with at least one grade first.",
      );
    if (
      !sameGrades(
        parsed.brackets.map((b) => b.gradeCode),
        grades,
      )
    )
      throw gradesMismatch();
    const [version] = (
      await tx.execute<{ id: string }>(
        sql`insert into app.salary_bracket_versions(workspace_id, pay_period, covers, effective_from) values (${access.workspaceId}::uuid, ${parsed.payPeriod}, ${parsed.covers}, ${parsed.effectiveFrom}::date) returning id`,
      )
    ).rows;
    await tx.execute(
      sql`insert into app.salary_brackets(version_id, workspace_id, grade_code, minimum_fils, midpoint_fils, maximum_fils) select ${version.id}::uuid, ${access.workspaceId}::uuid, b."gradeCode", b."minimumFils", b."midpointFils", b."maximumFils" from jsonb_to_recordset(${JSON.stringify(parsed.brackets)}::jsonb) as b("gradeCode" text, "minimumFils" bigint, "midpointFils" bigint, "maximumFils" bigint)`,
    );
    return (await readVersion(tx, access, version.id))!;
  });
}

/**
 * Replaces a draft's settings and figures by UPDATE only (no runtime delete): the input's grade codes
 * must be the draft's own. A published version is refused with nothing changed.
 */
export async function updateSalaryBracketDraft(
  p: Principal,
  versionId: string,
  input: SalaryBracketInput,
): Promise<SalaryBracketVersion> {
  const id = z.uuid().parse(versionId);
  const parsed = parseInput(input);
  return inBrackets(p, async (tx, access) => {
    await requireWriter(tx, p, access);
    const version = await readVersion(tx, access, id);
    if (!version) throw notFound();
    if (version.state !== "draft") throw versionPublished();
    if (
      !sameGrades(
        parsed.brackets.map((b) => b.gradeCode),
        version.brackets.map((b) => b.gradeCode),
      )
    )
      throw gradesMismatch();
    await tx.execute(
      sql`update app.salary_bracket_versions set pay_period = ${parsed.payPeriod}, covers = ${parsed.covers}, effective_from = ${parsed.effectiveFrom}::date where id = ${id}::uuid`,
    );
    await tx.execute(
      sql`update app.salary_brackets s set minimum_fils = b."minimumFils", midpoint_fils = b."midpointFils", maximum_fils = b."maximumFils" from jsonb_to_recordset(${JSON.stringify(parsed.brackets)}::jsonb) as b("gradeCode" text, "minimumFils" bigint, "midpointFils" bigint, "maximumFils" bigint) where s.version_id = ${id}::uuid and s.grade_code = b."gradeCode"`,
    );
    return (await readVersion(tx, access, id))!;
  });
}

/**
 * Publishes a draft whose grade codes are still those of the published job architecture, as the
 * next number, through the owner-run helper, which writes the one activity row. Nothing is retired.
 */
export async function publishSalaryBracketVersion(
  p: Principal,
  versionId: string,
): Promise<{ versionId: string; number: number }> {
  const id = z.uuid().parse(versionId);
  return inBrackets(p, async (tx, access) => {
    await requireWriter(tx, p, access);
    const version = await readVersion(tx, access, id);
    if (!version) throw notFound();
    if (version.state !== "draft") throw versionPublished();
    if (
      !sameGrades(
        version.brackets.map((b) => b.gradeCode),
        publishedGrades(access),
      )
    )
      throw new ApiError(
        409,
        "bracket_grades_changed",
        "The job grades changed since this draft was made. Create a new draft for the current grades.",
      );
    const { rows } = await tx.execute<{ number: number }>(
      sql`select tenant_context.publish_bracket_version(${id}::uuid) as number`,
    );
    return { versionId: id, number: rows[0].number };
  });
}
