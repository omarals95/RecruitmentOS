import { DrizzleQueryError, and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { records } from "@/db/schema";
import { kindToResource, uuidSchema, type RecordKind } from "@/domain/records";
import { accessContext, anyRecordScopeRule, authorize } from "./authz";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";

/** The record kinds tenant_context.add_assignment and remove_assignment accept. */
const ASSIGNABLE_KINDS: readonly RecordKind[] = [
  "vacancy",
  "application",
  "interview",
  "offer",
  "onboarding",
  "checklist",
  "task",
];
const assignmentInput = z
  .object({
    recordId: uuidSchema,
    userId: z.string().min(1).max(128),
    relation: z.string().min(1).max(40),
  })
  .strict();
const invalidAssignment = (message: string) =>
  new ApiError(400, "invalid_assignment", message);
const notFound = () =>
  new ApiError(404, "not_found", "Record not found in this team.");

/** The helpers' refusals by SQLSTATE; database message text never reaches the client. */
function refusal(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  switch ((cause as { code?: unknown } | undefined)?.code) {
    case "42501":
      throw new ApiError(
        403,
        "forbidden",
        "You do not have permission for this action.",
      );
    case "RQ013":
      throw invalidAssignment(
        "Choose a member of this team, a relation of recruiter, hiring manager, interviewer or assignee, and a vacancy, application, interview, offer, onboarding, checklist item or task.",
      );
    case "RQ014":
      throw new ApiError(
        403,
        "self_assignment_forbidden",
        "Your role sees only some records, so you cannot assign or unassign yourself. Ask a colleague who sees all records.",
      );
    case "RQ015":
      throw invalidAssignment(
        "Approver assignments arrive with approval requests.",
      );
    case "RQ016":
      throw notFound();
    default:
      throw error;
  }
}

/**
 * One withTeam transaction: the record in the caller's record scope (404 otherwise), edit access
 * to its resource, then the owner-run helper, which checks scope, membership, relation and
 * self-assignment again and writes the one audit row of a real change.
 */
async function changeAssignment(
  p: Principal,
  raw: unknown,
  helper: "add_assignment" | "remove_assignment",
): Promise<{ changed: boolean }> {
  const parsed = assignmentInput.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_input",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .slice(0, 8)
        .join("; "),
    );
  const { recordId, userId, relation } = parsed.data;
  try {
    return await withTeam(p, async (tx, access) => {
      const ctx = accessContext(p, access);
      const inScope = anyRecordScopeRule(ctx, "records");
      const [record] = await tx
        .select({ kind: records.kind })
        .from(records)
        .where(
          and(
            eq(records.teamId, p.teamId),
            eq(records.id, recordId),
            ...(inScope ? [inScope] : []),
          ),
        )
        .limit(1);
      if (!record) throw notFound();
      const kind = record.kind as RecordKind;
      if (!ASSIGNABLE_KINDS.includes(kind))
        throw invalidAssignment(
          "Only vacancies, applications, interviews, offers, onboarding, checklist items and tasks take assignments.",
        );
      authorize(ctx, { resource: kindToResource[kind], action: "edit" });
      const { rows } = await tx.execute<{ changed: boolean }>(
        sql`select tenant_context.${sql.raw(helper)}(${recordId}::uuid, ${userId}, ${relation}) as changed`,
      );
      return { changed: rows[0].changed };
    });
  } catch (error) {
    return refusal(error);
  }
}

/** Assigns a member of the team to a record; adding an existing assignment changes nothing. */
export function addAssignment(
  p: Principal,
  input: { recordId: string; userId: string; relation: string },
) {
  return changeAssignment(p, input, "add_assignment");
}

/** Removes a member's assignment from a record; removing a missing one changes nothing. */
export function removeAssignment(
  p: Principal,
  input: { recordId: string; userId: string; relation: string },
) {
  return changeAssignment(p, input, "remove_assignment");
}
