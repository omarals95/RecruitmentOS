import { DrizzleQueryError, sql } from "drizzle-orm";
import { z } from "zod";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import { idempotent } from "@/lib/records";

export const employeeErasureSchema = z
  .object({ confirmName: z.string().min(1).max(300) })
  .strict();
export type EmployeeErasureInput = z.infer<typeof employeeErasureSchema>;
/** What tenant_context.erase_employee removed or redacted; counts only. */
export type EmployeeErasure = {
  erasureId: string;
  alreadyErased: boolean;
  erasedAt: string;
  removed: {
    positionRows: number;
    activityRedacted: number;
    userLinks: number;
  };
};

const forbidden = () =>
  new ApiError(
    403,
    "employee_erasure_forbidden",
    "Only a company owner, signed in, can permanently erase an employee.",
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
 * Permanently erases one employee of the company through the owner-run helper, for
 * data-protection requests only: company owners signed in, after the typed name matches. A retry
 * for an erased employee returns the earlier erasure. The Idempotency-Key payload is the employee
 * id only, so no hash of the typed name is stored. Counts only; no employee value is returned or
 * logged.
 */
export async function eraseEmployee(
  p: Principal,
  employeeId: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<EmployeeErasure> {
  if (p.authType !== "session") throw forbidden();
  parse(z.uuid(), employeeId);
  return withTeam(p, async (tx, access) => {
    // Before the body is validated, so anyone else gets 403 whatever they send.
    if (access.companyLevel !== "owner") throw forbidden();
    const { confirmName } = parse(employeeErasureSchema, input);
    return idempotent(
      tx,
      { principal: p, access },
      "employee.erase",
      idempotencyKey,
      { employeeId },
      async () => {
        let erased: EmployeeErasure | null;
        try {
          const { rows } = await tx.execute<{
            result: EmployeeErasure | null;
          }>(
            sql`select tenant_context.erase_employee(${employeeId}::uuid, ${confirmName}, 'app') as result`,
          );
          erased = rows[0]?.result ?? null;
        } catch (error) {
          const cause =
            error instanceof DrizzleQueryError ? error.cause : error;
          const { code } = (cause as { code?: unknown } | undefined) ?? {};
          if (code === "RQ003")
            throw new ApiError(
              409,
              "erasure_confirmation_mismatch",
              "Type the employee's name exactly as shown to confirm.",
            );
          if (code === "42501") throw forbidden();
          throw error;
        }
        if (!erased)
          throw new ApiError(404, "not_found", "Employee not found.");
        return {
          erasureId: erased.erasureId,
          alreadyErased: erased.alreadyErased,
          erasedAt: new Date(erased.erasedAt).toISOString(),
          removed: {
            positionRows: Number(erased.removed.positionRows),
            activityRedacted: Number(erased.removed.activityRedacted),
            userLinks: Number(erased.removed.userLinks),
          },
        };
      },
    );
  });
}
