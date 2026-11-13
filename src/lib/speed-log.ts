import { and, asc, eq, gte, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { speedSampleBudgets, speedSamples } from "@/db/schema";
import {
  SPEED_ACTIONS,
  SPEED_MAX_MS,
  SPEED_MAX_SAMPLES,
  SPEED_RETENTION_DAYS,
  SPEED_ROUTE_MAX_LENGTH,
  SPEED_ROUTE_NAME,
  SPEED_TEAM_HOURLY_ROWS,
  SPEED_USER_HOURLY_ROWS,
} from "@/domain/speed";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";

const duration = z.number().int().min(0).max(SPEED_MAX_MS);
/** Timings and fixed names only; a route sample may also carry its reported db time. */
export const speedSamplesSchema = z
  .object({
    samples: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("action"),
              name: z.enum(SPEED_ACTIONS),
              durationMs: duration,
            })
            .strict(),
          z
            .object({
              kind: z.literal("route"),
              name: z
                .string()
                .max(SPEED_ROUTE_MAX_LENGTH)
                .regex(SPEED_ROUTE_NAME),
              durationMs: duration,
              dbMs: duration.optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(SPEED_MAX_SAMPLES),
  })
  .strict();
export type SpeedSamplesInput = z.infer<typeof speedSamplesSchema>;

/** Rows past the 30 days that one write deletes at most, so the purge stays bounded. */
const PURGE_LIMIT = 1000;

/**
 * Any team member, viewers included, under the read context like notification reads. Under the
 * team's speed lock it stores only the first samples that fit the caller's and the team's budget
 * for this clock hour, updates the caller's budget row and runs one bounded purge of the team's
 * expired rows. Returns the number stored; the rest is dropped. Nothing is audited.
 */
export async function recordSpeedSamples(
  p: Principal,
  input: SpeedSamplesInput,
): Promise<number> {
  return withTeam(p, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`speed-samples:${p.teamId}`}, 0))`,
    );
    // A budget row from an earlier hour counts as 0.
    const {
      rows: [used],
    } = await tx.execute<{ userRows: number; teamRows: number }>(
      sql`select coalesce((select row_count from app.speed_sample_budgets where team_id = ${p.teamId} and user_id = ${p.userId} and window_start = date_trunc('hour', now())), 0)::integer as "userRows", (select count(*) from app.speed_samples where team_id = ${p.teamId} and recorded_at = date_trunc('hour', now()))::integer as "teamRows"`,
    );
    const userRows = Number(used?.userRows ?? 0);
    const allowed = Math.max(
      0,
      Math.min(
        input.samples.length,
        SPEED_USER_HOURLY_ROWS - userRows,
        SPEED_TEAM_HOURLY_ROWS - Number(used?.teamRows ?? 0),
      ),
    );
    if (allowed > 0)
      await tx.insert(speedSamples).values(
        input.samples.slice(0, allowed).map((sample) => ({
          teamId: p.teamId,
          kind: sample.kind,
          name: sample.name,
          durationMs: sample.durationMs,
          dbMs: sample.kind === "route" ? (sample.dbMs ?? null) : null,
        })),
      );
    const budget = {
      windowStart: sql`date_trunc('hour', now())`,
      rowCount: userRows + allowed,
    };
    await tx
      .insert(speedSampleBudgets)
      .values({ teamId: p.teamId, userId: p.userId, ...budget })
      .onConflictDoUpdate({
        target: [speedSampleBudgets.teamId, speedSampleBudgets.userId],
        set: budget,
      });
    await tx.execute(
      sql`delete from app.speed_samples where id in (select id from app.speed_samples where team_id = ${p.teamId} and recorded_at < now() - make_interval(days => ${SPEED_RETENTION_DAYS}) limit ${PURGE_LIMIT})`,
    );
    return allowed;
  });
}

export interface SpeedSummaryRow {
  kind: "action" | "route";
  name: string;
  samples: number;
  medianMs: number;
  p95Ms: number;
  medianDbMs?: number | null;
  p95DbMs?: number | null;
}
/** Owners and admins: typical (median) and slow (95th percentile) times per name, last 30 days. */
export async function speedSummary(p: Principal): Promise<SpeedSummaryRow[]> {
  if (p.role !== "owner" && p.role !== "admin")
    throw new ApiError(
      403,
      "speed_log_forbidden",
      "Only team owners and admins can view speed timings.",
    );
  const percentile = (fraction: number, column: AnyColumn) =>
    sql<
      number | null
    >`round(percentile_cont(${sql.raw(String(fraction))}) within group (order by ${column}))::integer`;
  return withTeam(p, async (tx) => {
    const rows = await tx
      .select({
        kind: speedSamples.kind,
        name: speedSamples.name,
        samples: sql<number>`count(*)::integer`,
        medianMs: percentile(0.5, speedSamples.durationMs),
        p95Ms: percentile(0.95, speedSamples.durationMs),
        medianDbMs: percentile(0.5, speedSamples.dbMs),
        p95DbMs: percentile(0.95, speedSamples.dbMs),
      })
      .from(speedSamples)
      .where(
        and(
          eq(speedSamples.teamId, p.teamId),
          gte(
            speedSamples.recordedAt,
            sql`now() - make_interval(days => ${SPEED_RETENTION_DAYS})`,
          ),
        ),
      )
      .groupBy(speedSamples.kind, speedSamples.name)
      .orderBy(asc(speedSamples.kind), asc(speedSamples.name));
    return rows.map(({ medianDbMs, p95DbMs, ...row }) => ({
      ...row,
      medianMs: Number(row.medianMs),
      p95Ms: Number(row.p95Ms),
      ...(row.kind === "route" ? { medianDbMs, p95DbMs } : {}),
    }));
  });
}
