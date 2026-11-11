import { DrizzleQueryError, sql } from "drizzle-orm";
import { z } from "zod";
import { userNotFound } from "./admin-users";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";
import { idempotent } from "./records";
import { cannotChangeSelf } from "./user-account";

export const userAnonymisationSchema = z
  .object({ confirmName: z.string().min(1).max(300) })
  .strict();
export type UserAnonymisationInput = z.infer<typeof userAnonymisationSchema>;
/** What tenant_context.anonymise_user removed or redacted; counts only. */
export type UserAnonymisation = {
  anonymisationId: string;
  alreadyAnonymised: boolean;
  anonymisedAt: string;
  removed: {
    memberships: number;
    sessions: number;
    apiTokens: number;
    twoStep: number;
    configuredRoles: number;
    recordAssignments: number;
    companyAuthority: number;
    invitations: number;
    activityRedacted: number;
  };
};

const forbidden = () =>
  new ApiError(
    403,
    "anonymisation_forbidden",
    "Only a company owner, signed in, can anonymise a user account.",
  );
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_input",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .slice(0, 8)
        .join("; "),
    );
  return parsed.data;
}

/**
 * The helper's refusals once the service has allowed the caller, as API errors; anything else is
 * rethrown.
 */
export function userAnonymisationError(error: unknown): unknown {
  const code = (
    (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown } | undefined
  )?.code;
  if (code === "RQ003")
    return new ApiError(
      409,
      "anonymisation_confirmation_mismatch",
      "Type the person's name exactly as shown to confirm.",
    );
  if (code === "RQ019")
    return new ApiError(
      409,
      "last_team_owner",
      "This person is the last owner of a team. Make someone else that team's owner first.",
    );
  if (code === "RQ005")
    return new ApiError(
      409,
      "last_company_owner",
      "The last company owner cannot be anonymised. Make someone else a company owner first.",
    );
  if (code === "RQ020")
    return new ApiError(
      409,
      "member_of_other_company",
      "This person is also in a team outside your company, so their account cannot be anonymised here.",
    );
  if (code === "RQ018") return cannotChangeSelf();
  if (code === "42501") return forbidden();
  if (code === "22023")
    return new ApiError(400, "invalid_input", "Check the supplied fields.");
  return error;
}

/**
 * Permanently anonymises one person of the company through the owner-run helper: company owners
 * signed in, never on themselves, after the typed name matches. A retry, by the same or a new
 * Idempotency-Key, answers the earlier anonymisation with alreadyAnonymised. The Idempotency-Key
 * payload is the user id only, so no hash of the typed name is stored. Counts only; no name or
 * email is returned or logged.
 */
export async function anonymiseUser(
  p: Principal,
  userId: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<UserAnonymisation> {
  if (p.authType !== "session") throw forbidden();
  if (userId === p.userId) throw cannotChangeSelf();
  return withTeam(p, async (tx, access) => {
    // Before the body is validated, so anyone else gets 403 whatever they send.
    if (access.companyLevel !== "owner") throw forbidden();
    const { confirmName } = parse(userAnonymisationSchema, input);
    return idempotent(
      tx,
      { principal: p, access },
      "user.anonymise",
      idempotencyKey,
      { userId },
      async () => {
        let anonymised: UserAnonymisation | null;
        try {
          const { rows } = await tx.execute<{
            result: UserAnonymisation | null;
          }>(
            sql`select tenant_context.anonymise_user(${userId}::text, ${confirmName}, 'app') as result`,
          );
          anonymised = rows[0]?.result ?? null;
        } catch (error) {
          throw userAnonymisationError(error);
        }
        if (!anonymised) throw userNotFound();
        const { removed } = anonymised;
        return {
          anonymisationId: anonymised.anonymisationId,
          alreadyAnonymised: anonymised.alreadyAnonymised,
          anonymisedAt: new Date(anonymised.anonymisedAt).toISOString(),
          removed: {
            memberships: Number(removed.memberships),
            sessions: Number(removed.sessions),
            apiTokens: Number(removed.apiTokens),
            twoStep: Number(removed.twoStep),
            configuredRoles: Number(removed.configuredRoles),
            recordAssignments: Number(removed.recordAssignments),
            companyAuthority: Number(removed.companyAuthority),
            invitations: Number(removed.invitations),
            activityRedacted: Number(removed.activityRedacted),
          },
        };
      },
      undefined,
      // The same key again: the person was anonymised by that earlier request.
      (cached) => ({ ...cached, alreadyAnonymised: true }),
    );
  });
}
