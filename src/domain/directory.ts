import { z } from "zod";
import { configLabel } from "./config";

// Positions, employees and their positions (drizzle/0034_positions_employees.sql). Titles, codes,
// names and employee numbers are text facts under the configuration label rule; work email and
// phone follow the candidate contact rules. Strict objects refuse unknown keys.
export const EMPLOYEE_STATUSES = ["active", "left"] as const;
/** Shown for the company owners' retention review only; nothing enforces a class yet (D11). */
export const EMPLOYEE_RETENTION_CLASSES = ["standard", "extended"] as const;
const workEmail = z.email().max(320).nullable();
const workPhone = z
  .string()
  .trim()
  .max(100)
  .transform((value) => value || null)
  .nullable();

export const positionInput = z
  .object({
    title: configLabel,
    code: configLabel,
    orgUnitId: z.uuid(),
    isManager: z.boolean().optional(),
    jobRoleId: z.uuid().optional(),
  })
  .strict();
export const positionFacts = z
  .object({
    title: configLabel.optional(),
    isManager: z.boolean().optional(),
    jobRoleId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
export const positionMove = z.object({ orgUnitId: z.uuid() }).strict();
export const directoryArchive = z
  .object({ archived: z.literal(true) })
  .strict();
/** One operation per request: a facts update, a move or an archive. */
export const positionPatch = z.union([
  positionMove,
  directoryArchive,
  positionFacts,
]);

export const employeeInput = z
  .object({
    displayName: configLabel,
    employeeNumber: configLabel,
    workEmail: workEmail.optional(),
    workPhone: workPhone.optional(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    retentionClass: z.enum(EMPLOYEE_RETENTION_CLASSES).optional(),
    userId: z.string().min(1).max(128).optional(),
  })
  .strict();
export const employeeFacts = z
  .object({
    displayName: configLabel.optional(),
    employeeNumber: configLabel.optional(),
    workEmail: workEmail.optional(),
    workPhone: workPhone.optional(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    retentionClass: z.enum(EMPLOYEE_RETENTION_CLASSES).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
export const employeeLink = z
  .object({ userId: z.string().min(1).max(128).nullable() })
  .strict();
/** One operation per request: a facts update, a user link (null unlinks) or an archive. */
export const employeePatch = z.union([
  employeeLink,
  directoryArchive,
  employeeFacts,
]);
/** The employee's full set of current positions, at most one of them primary. */
export const employeePositionsInput = z
  .object({
    positions: z
      .array(z.object({ positionId: z.uuid(), primary: z.boolean() }).strict())
      .max(20)
      .refine(
        (list) =>
          new Set(list.map((entry) => entry.positionId)).size === list.length,
        "Each position may appear once.",
      )
      .refine(
        (list) => list.filter((entry) => entry.primary).length <= 1,
        "At most one position is primary.",
      ),
  })
  .strict();

const page = z.coerce.number().int().min(1).max(1000000).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(100);
export const positionListQuery = z
  .object({ unitId: z.uuid().optional(), page, pageSize })
  .strict();
export const employeeListQuery = z
  .object({
    unitId: z.uuid().optional(),
    levelId: z.uuid().optional(),
    positionId: z.uuid().optional(),
    status: z.enum(EMPLOYEE_STATUSES).optional(),
    /** A case-insensitive part of the display name or employee number. */
    search: z.string().trim().min(1).max(120).optional(),
    includeArchived: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    page,
    pageSize,
  })
  .strict();
export const retentionReviewQuery = z.object({ page, pageSize }).strict();
