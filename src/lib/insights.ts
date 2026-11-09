import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import {
  activity,
  candidateStates,
  notificationReads,
  records,
  uploads,
} from "@/db/schema";
import type { TeamTx } from "@/db";
import {
  accessContext,
  authorize,
  decide,
  hiddenKeys,
  recordIdInScope,
  redact,
  scopeFilter,
  type AccessContext,
  type AccessRequest,
} from "./authz";
import { withTeam } from "./db-team";
import type { Principal } from "./principal";
import { ApiError } from "./errors";
import {
  APPLICATION_STAGES,
  daySchema,
  dubaiToday,
  resourceToKind,
  type RecordDto,
  type RecordKind,
  type ResourceName,
} from "@/domain/records";
import { listInside } from "./records";

type Count = { name: string; count: number };
const GROUP_LIMIT = 100;
function invalid(message: string): never {
  throw new ApiError(400, "invalid_query", message);
}
function validateParams(params: URLSearchParams, allowed: readonly string[]) {
  for (const key of params.keys())
    if (!allowed.includes(key) || params.getAll(key).length !== 1)
      invalid(`Unsupported or repeated filter: ${key}.`);
}
/** True when the caller may see every one of these fields of the kind. */
function visible(ctx: AccessContext, kind: RecordKind, ...keys: string[]) {
  const hidden = hiddenKeys(ctx, kind);
  return keys.every((key) => !hidden.has(key));
}
/** Allowed when any of the requests is; otherwise authorize()'s own 403 for the first. */
function authorizeAny(ctx: AccessContext, requests: AccessRequest[]) {
  if (!requests.some((request) => decide(ctx, request)))
    authorize(ctx, requests[0]);
}
const RECORD_RESOURCES = Object.keys(resourceToKind) as ResourceName[];
/** The overview and analytics read every inventory kind, so each must be viewable on the page. */
function authorizeInventory(ctx: AccessContext, page: "home" | "analytics") {
  for (const resource of [
    "candidates",
    "vacancies",
    "applications",
    "tasks",
    "interviews",
    "offers",
    "onboarding",
  ] as const)
    authorize(ctx, { page, resource, action: "view" });
}
function active(ctx: AccessContext, kind: RecordKind): SQL {
  return and(
    ...scopeFilter(ctx, kind),
    isNull(records.archivedAt),
    isNull(records.privateOwnerId),
  )!;
}
function asDto(row: typeof records.$inferSelect): RecordDto {
  // The scope columns are not part of a record's response.
  const {
    teamId: _teamId,
    orgUnitId: _orgUnitId,
    scopeVacancyId: _scopeVacancyId,
    scopeApplicationId: _scopeApplicationId,
    createdAt,
    updatedAt,
    archivedAt,
    ...rest
  } = row;
  return {
    ...rest,
    data: row.data as RecordDto["data"],
    kind: row.kind as RecordDto["kind"],
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    archivedAt: archivedAt?.toISOString() ?? null,
  };
}
/** A count that filters by a field the caller may not see is left out. */
async function inventory(tx: TeamTx, ctx: AccessContext) {
  const { principal: p } = ctx;
  const where = (kind: RecordKind, ...conditions: SQL[]) =>
    and(...scopeFilter(ctx, kind), ...conditions)!;
  const [counts] = await tx
    .select({
      candidates: sql<number>`count(*) filter(where ${where("candidate")})::int`,
      ...(visible(ctx, "vacancy", "status")
        ? {
            vacancies: sql<number>`count(*) filter(where ${where("vacancy", sql`${records.data}->>'status'='Open'`)})::int`,
          }
        : {}),
      applications: sql<number>`count(*) filter(where ${where("application")})::int`,
      tasks: sql<number>`count(*) filter(where ${where("task", notCompleted(p, sql`${records.bucketId}`))})::int`,
      ...(visible(ctx, "interview", "status")
        ? {
            interviews: sql<number>`count(*) filter(where ${where("interview", sql`${records.data}->>'status'='Scheduled'`)})::int`,
          }
        : {}),
      offers: sql<number>`count(*) filter(where ${where("offer")})::int`,
      ...(visible(ctx, "onboarding", "status")
        ? {
            onboarding: sql<number>`count(*) filter(where ${where("onboarding", sql`${records.data}->>'status'<>'Completed'`)})::int`,
          }
        : {}),
    })
    .from(records)
    .where(
      and(
        eq(records.teamId, p.teamId),
        isNull(records.archivedAt),
        isNull(records.privateOwnerId),
      ),
    );
  return counts;
}
/**
 * A task is completed when its bucket says so; a missing flag means not completed. The flag is
 * board configuration, read whatever the caller's field rules.
 */
function notCompleted(p: Principal, bucketId: SQL) {
  return sql`not exists(select 1 from ${records} b where b.team_id=${p.teamId} and b.id=${bucketId} and b.kind='bucket' and b.data->>'completed'='true')`;
}
async function stages(tx: TeamTx, ctx: AccessContext): Promise<Count[]> {
  if (!visible(ctx, "application", "stage")) return [];
  const rows = await tx
    .select({ name: sql<string>`${records.data}->>'stage'`, count: count() })
    .from(records)
    .where(active(ctx, "application"))
    .groupBy(sql`${records.data}->>'stage'`);
  return APPLICATION_STAGES.map((name) => ({
    name,
    count: rows.find((row) => row.name === name)?.count ?? 0,
  }));
}
// Groups that only count records in one status.
const statusFilters: Record<string, string> = {
  "offer.declineReason": "Declined",
  "vacancy.department": "Open",
};
/** Empty when the group field, or the status it filters by, is hidden from the caller. */
async function grouped(
  tx: TeamTx,
  ctx: AccessContext,
  kind: RecordKind,
  field: string,
  array = false,
): Promise<Count[]> {
  // Aggregate in PostgreSQL; do not load candidate texts, comments or notes.
  const status = statusFilters[`${kind}.${field}`];
  if (!visible(ctx, kind, field, ...(status ? ["status"] : []))) return [];
  const where = and(
    active(ctx, kind),
    ...(status ? [sql`${records.data}->>'status'=${status}`] : []),
  );
  const source = array
    ? sql`select distinct ${records.id}, coalesce(nullif(btrim(tag.value),''),'Not recorded') as name from ${records}
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(${records.data}->${field})='array' and ${records.data}->${field}<>'[]'::jsonb then ${records.data}->${field} else '["Not recorded"]'::jsonb end) tag(value)
        where ${where}`
    : sql`select coalesce(nullif(btrim(${records.data}->>${field}),''),'Not recorded') as name from ${records} where ${where}`;
  const result = await tx.execute<{
    name: string;
    count: number;
  }>(sql`with groups as(select name,count(*)::int as count from (${source}) source group by name), ranked as(select name,count,row_number() over(order by count desc,name) as position from groups)
    select name,count from ranked where position<=${GROUP_LIMIT}
    union all select 'Other recorded values',sum(count)::int from ranked where position>${GROUP_LIMIT} having count(*)>0`);
  return result.rows.sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

export async function overview(p: Principal) {
  const now = new Date(),
    today = dubaiToday(now);
  const result = await withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorizeInventory(ctx, "home");
    const recentActivity = activityQuery(
      ctx,
      new URLSearchParams({ pageSize: "8" }),
      { excludeKinds: ["mcp-tool"] },
    );
    const counts = await inventory(tx, ctx);
    const [shortlisted] = await tx
      .select({ count: count() })
      .from(candidateStates)
      .innerJoin(
        records,
        and(
          eq(records.teamId, candidateStates.teamId),
          eq(records.id, candidateStates.candidateId),
        ),
      )
      .where(
        and(
          eq(candidateStates.teamId, p.teamId),
          eq(candidateStates.userId, p.userId),
          eq(candidateStates.shortlisted, true),
          ...scopeFilter(ctx, "candidate"),
          isNull(records.archivedAt),
        ),
      );
    // A coverage figure for a field the caller may not see is left out.
    const shown = (key: string) => visible(ctx, "candidate", key);
    const [coverage] = await tx
      .select({
        ...(shown("email")
          ? {
              email: sql<number>`count(*) filter(where coalesce(${records.data}->>'email','')<>'')::int`,
            }
          : {}),
        ...(shown("phone")
          ? {
              phone: sql<number>`count(*) filter(where coalesce(${records.data}->>'phone','')<>'')::int`,
            }
          : {}),
        ...(shown("yearsExperience")
          ? {
              experience: sql<number>`count(*) filter(where jsonb_typeof(${records.data}->'yearsExperience')='number')::int`,
            }
          : {}),
        ...(shown("reviewStatus")
          ? {
              reviewRequired: sql<number>`count(*) filter(where coalesce(${records.data}->>'reviewStatus','') !~* '^(verified|reviewed|complete|completed)$')::int`,
            }
          : {}),
        total: count(),
      })
      .from(records)
      .where(active(ctx, "candidate"));
    let cvCounts: {
      cvFiles?: number;
      pendingCvs?: number;
      candidatesWithCvs?: number;
    } = {};
    if (ctx.scopes.includes("cvs:read")) {
      [cvCounts] = await tx
        .select({
          cvFiles: sql<number>`count(*) filter(where ${uploads.status}='ready')::int`,
          pendingCvs: sql<number>`count(*) filter(where ${uploads.status}='pending')::int`,
          candidatesWithCvs: sql<number>`count(distinct ${uploads.candidateId}) filter(where ${uploads.status}='ready')::int`,
        })
        .from(uploads)
        .innerJoin(
          records,
          and(
            eq(records.teamId, uploads.teamId),
            eq(records.id, uploads.candidateId),
          ),
        )
        .where(
          and(
            eq(uploads.teamId, p.teamId),
            ...scopeFilter(ctx, "candidate"),
            isNull(records.archivedAt),
          ),
        );
    }
    const upcoming = visible(ctx, "interview", "status", "startAt")
      ? await tx
          .select()
          .from(records)
          .where(
            and(
              active(ctx, "interview"),
              sql`${records.data}->>'status'='Scheduled'`,
              sql`(${records.data}->>'startAt')::timestamptz>=${now.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(
            asc(sql`(${records.data}->>'startAt')::timestamptz`),
            asc(records.id),
          )
          .limit(6)
      : [];
    const overdue = visible(ctx, "task", "dueDate")
      ? await tx
          .select()
          .from(records)
          .where(
            and(
              active(ctx, "task"),
              sql`coalesce(${records.data}->>'dueDate','')<>''`,
              sql`${records.data}->>'dueDate'<${today}`,
              notCompleted(p, sql`${records.bucketId}`),
            ),
          )
          .orderBy(asc(sql`${records.data}->>'dueDate'`), asc(records.id))
          .limit(6)
      : [];
    return {
      counts: { ...counts, shortlisted: shortlisted.count, ...cvCounts },
      coverage,
      stages: await stages(tx, ctx),
      departments: await grouped(tx, ctx, "vacancy", "department"),
      categories: await grouped(tx, ctx, "candidate", "folderCategories", true),
      upcomingInterviews: upcoming.map((row) => redact(ctx, asDto(row))),
      overdueTasks: overdue.map((row) => redact(ctx, asDto(row))),
      // In the same transaction, so the signed context is installed once; the page needs no total.
      // MCP tool audit rows stay on the Activity screen; they would flood the dashboard.
      recentActivity: await activityPage(tx, recentActivity),
    };
  });
  return {
    ...result,
    asOf: now.toISOString(),
    timezone: "Asia/Dubai",
  };
}

/** Observed stage changes of applications in the caller's record scope. */
function observedEvents(ctx: AccessContext, end: string) {
  const { principal: p } = ctx;
  const inScope = recordIdInScope(ctx, sql`activity.record_id`);
  return sql`select record_id,created_at,id,action,metadata->>'toStage' as to_stage,metadata->>'fromStage' as from_stage
    from ${activity} where team_id=${p.teamId} and kind='application' and actor_type<>'import' and created_at<=${end}::timestamptz
    and jsonb_typeof(metadata->'toStage')='string'${inScope ? sql` and ${inScope}` : sql``}`;
}
export async function analytics(p: Principal, params: URLSearchParams) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorizeInventory(ctx, "analytics");
    validateParams(params, ["from", "to"]);
    const to = params.get("to") || dubaiToday();
    if (!daySchema.safeParse(to).success) invalid("Use a valid end date.");
    const defaultStart = new Date(`${to}T00:00:00Z`);
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
    const from = params.get("from") || defaultStart.toISOString().slice(0, 10);
    if (
      !daySchema.safeParse(from).success ||
      from > to ||
      (Date.parse(to) - Date.parse(from)) / 86400000 > 366
    )
      invalid("Use an ordered date range of at most 367 days.");
    const start = `${from}T00:00:00+04:00`,
      end = `${to}T23:59:59.999+04:00`;
    // The observed stage history is application stage data: left out when the stage is hidden.
    const history = visible(ctx, "application", "stage");
    const observed = observedEvents(ctx, end);
    const daily = history
      ? await tx.execute<{
          date: string;
          applications: number;
          hired: number;
        }>(sql`with events as(${observed}), first_hires as(select record_id,min(created_at) as at from events where to_stage='Hired' group by record_id), daily as(
      select to_char(created_at at time zone 'Asia/Dubai','YYYY-MM-DD') as day,count(*)::int as applications,0::int as hired from events where action='created' and created_at>=${start}::timestamptz group by day
      union all select to_char(at at time zone 'Asia/Dubai','YYYY-MM-DD') as day,0::int,count(*)::int from first_hires where at>=${start}::timestamptz group by day)
      select day as date,sum(applications)::int as applications,sum(hired)::int as hired from daily group by day`)
      : null;
    const durationRows = history
      ? await tx.execute<{
          stage: string;
          averageDays: number;
          count: number;
        }>(sql`with events as(${observed}), transitions as(select *,lag(to_stage) over(partition by record_id order by created_at,id) as previous_stage,lag(created_at) over(partition by record_id order by created_at,id) as previous_at from events)
      select previous_stage as stage,avg(extract(epoch from(created_at-previous_at))/86400)::float8 as "averageDays",count(*)::int as count from transitions where previous_stage=from_stage and created_at>=previous_at and created_at>=${start}::timestamptz group by previous_stage`)
      : null;
    const hireRows = history
      ? await tx.execute<{
          hiresCount: number;
          timeToHireDays: number | null;
          timeToHireSample: number;
        }>(sql`with events as(${observed}), per_application as(select record_id,min(created_at) filter(where action='created') as born,min(created_at) filter(where to_stage='Hired') as hired from events group by record_id)
      select count(*)::int as "hiresCount",avg(extract(epoch from(hired-born))/86400) filter(where born is not null and hired>=born)::float8 as "timeToHireDays",count(*) filter(where born is not null and hired>=born)::int as "timeToHireSample" from per_application where hired>=${start}::timestamptz`)
      : null;
    const conversionRows = history
      ? await tx.execute<{
          stage: string;
          count: number;
          denominator: number;
        }>(
          sql`with events as(${observed}) select to_stage as stage,count(distinct record_id)::int as count,(select count(distinct record_id)::int from events) as denominator from events group by to_stage`,
        )
      : null;
    const experienceRows = visible(ctx, "candidate", "yearsExperience")
      ? await tx.execute<{ name: string; count: number }>(
          sql`select band as name,count(*)::int as count from(select case when jsonb_typeof(data->'yearsExperience')<>'number' or data->'yearsExperience' is null then 'Not recorded' when (data->>'yearsExperience')::numeric<3 then '0-2 years' when(data->>'yearsExperience')::numeric<6 then '3-5 years' when(data->>'yearsExperience')::numeric<11 then '6-10 years' else '11+ years' end as band from ${records} where ${and(...scopeFilter(ctx, "candidate"), isNull(records.archivedAt))}) bands group by band`,
        )
      : null;
    const series = [];
    if (daily) {
      const dailyMap = new Map(daily.rows.map((row) => [row.date, row]));
      for (
        let date = new Date(`${from}T00:00:00Z`);
        date <= new Date(`${to}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + 1)
      ) {
        const day = date.toISOString().slice(0, 10);
        series.push(
          dailyMap.get(day) ?? { date: day, applications: 0, hired: 0 },
        );
      }
    }
    return {
      counts: await inventory(tx, ctx),
      stages: await stages(tx, ctx),
      departments: await grouped(tx, ctx, "vacancy", "department"),
      categories: await grouped(tx, ctx, "candidate", "folderCategories", true),
      series,
      offers: await grouped(tx, ctx, "offer", "status"),
      declineReasons: await grouped(tx, ctx, "offer", "declineReason"),
      sources: await grouped(tx, ctx, "application", "source"),
      experience: experienceRows
        ? [
            "Not recorded",
            "0-2 years",
            "3-5 years",
            "6-10 years",
            "11+ years",
          ].map((name) => ({
            name,
            count:
              experienceRows.rows.find((row) => row.name === name)?.count ?? 0,
          }))
        : [],
      emirates: await grouped(tx, ctx, "candidate", "residenceEmirate"),
      from,
      to,
      ...hireRows?.rows[0],
      stageDurations: durationRows
        ? APPLICATION_STAGES.map(
            (stage) =>
              durationRows.rows.find((row) => row.stage === stage) ?? {
                stage,
                averageDays: null,
                count: 0,
              },
          )
        : [],
      conversions: conversionRows
        ? APPLICATION_STAGES.map((stage) => {
            const row = conversionRows.rows.find(
              (item) => item.stage === stage,
            );
            const denominator = conversionRows.rows[0]?.denominator ?? 0;
            return {
              stage,
              count: row?.count ?? 0,
              rate: denominator ? (row?.count ?? 0) / denominator : null,
            };
          })
        : [],
      historyNote:
        "Inventory charts show current active records. Dated series and first hires use changes observed by RecruitmentOS in Asia/Dubai; imported records do not invent past applications or hires. Time to hire requires an observed creation and first hire. Stage durations require observed entries and exits. Conversion is the all-observed-history share reaching each stage through the end date. Categories reproduce source folders, not suitability assessments. Category charts show the first 100 groups plus the combined remainder.",
    };
  });
}

/** MCP tools about the caller's own private state; their audit rows are shown only to their actor. */
export const PERSONAL_MCP_TOOLS = [
  "get_my_candidate_state",
  "update_my_candidate_state",
  "list_saved_views",
  "create_saved_view",
  "mark_notifications_read",
] as const;

/**
 * Company structure and authority rows: ids and field names only, but only for sessions with
 * company authority; API tokens, OAuth grants and members without it never see them in the feed.
 */
const COMPANY_ACTIVITY_KINDS = [
  "directory",
  "scope",
  "role-assignment",
  "workspace-authority",
  "employee-erasure",
  "org-import",
];

/**
 * Validates an activity query inside the caller's transaction and builds its filter from the
 * context: the scopes install stored, the company authority it derived, the record kinds the caller
 * may view and the metadata keys that carry a hidden field's value.
 */
function activityQuery(
  ctx: AccessContext,
  params: URLSearchParams,
  options: { excludeKinds?: string[] } = {},
) {
  const { principal: p, access } = ctx;
  validateParams(params, ["page", "pageSize", "recordId", "search", "kind"]);
  const pageResult = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000000)
      .safeParse(params.get("page") || 1),
    sizeResult = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .safeParse(params.get("pageSize") || 30);
  if (!pageResult.success || !sizeResult.success)
    invalid("Use an integer page and a page size between 1 and 100.");
  const page = pageResult.data,
    pageSize = sizeResult.data,
    recordId = params.get("recordId");
  if (recordId && !z.uuid().safeParse(recordId).success)
    invalid("Invalid record identifier.");
  const search = (params.get("search") ?? "").trim(),
    kind = (params.get("kind") ?? "").trim();
  if (search.length > 500)
    invalid("Activity search is limited to 500 characters.");
  if (
    kind &&
    !z
      .enum([
        ...Object.values(resourceToKind),
        "cv",
        "api-token",
        "mcp-tool",
        "export",
      ])
      .safeParse(kind).success
  )
    invalid("Unsupported activity record type.");
  // The accessor resolves names only for events the signed context may read.
  const actorName = sql<
    string | null
  >`tenant_context.activity_actor_name(${activity.id})`;
  const searchFilter: SQL[] = [];
  if (search) {
    searchFilter.push(
      sql`strpos(lower(concat_ws(' ',${activity.summary},${activity.action},${actorName})),lower(${search}))>0`,
    );
  }
  // Rows of a record kind the caller may not view; for the built-in roles, candidate rows without
  // candidates:read.
  const unseen = RECORD_RESOURCES.filter(
    (resource) => !decide(ctx, { resource, action: "view" }),
  ).map((resource) => resourceToKind[resource]);
  // Rows about a record outside the caller's record scope, for a limited role.
  const inScope = recordIdInScope(ctx, sql`${activity.recordId}`);
  const filter = and(
    eq(activity.teamId, p.teamId),
    ...(recordId ? [eq(activity.recordId, recordId)] : []),
    sql`(${activity.action}<>'personal_state_updated' or ${activity.actorId}=${p.userId})`,
    sql`(${activity.kind}<>'saved-view' or ${activity.actorId}=${p.userId})`,
    sql`(${activity.kind}<>'mcp-tool' or not ${inArray(sql`coalesce(${activity.metadata}->>'tool','')`, [...PERSONAL_MCP_TOOLS])} or ${activity.actorId}=${p.userId})`,
    ...(unseen.length ? [notInArray(activity.kind, unseen)] : []),
    ...(kind ? [eq(activity.kind, kind)] : []),
    ...(options.excludeKinds?.length
      ? [notInArray(activity.kind, options.excludeKinds)]
      : []),
    ...(p.authType !== "session" || access.companyLevel === null
      ? [notInArray(activity.kind, COMPANY_ACTIVITY_KINDS)]
      : []),
    ...(inScope ? [inScope] : []),
    ...searchFilter,
  );
  // Stage and status changes carry the field values in their metadata.
  const hiddenMetadata = [
    ...(visible(ctx, "application", "stage") ? [] : ["fromStage", "toStage"]),
    ...(visible(ctx, "offer", "status") ? [] : ["fromStatus", "toStatus"]),
  ];
  return { page, pageSize, filter, actorName, hiddenMetadata };
}
async function activityPage(
  tx: TeamTx,
  {
    page,
    pageSize,
    filter,
    actorName,
    hiddenMetadata,
  }: ReturnType<typeof activityQuery>,
) {
  const data = await tx
    .select({
      id: activity.id,
      recordId: activity.recordId,
      actorId: activity.actorId,
      actorName,
      actorType: activity.actorType,
      action: activity.action,
      kind: activity.kind,
      summary: activity.summary,
      metadata: activity.metadata,
      createdAt: activity.createdAt,
    })
    .from(activity)
    .where(filter)
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return data.map((row) => ({
    ...row,
    ...(hiddenMetadata.length
      ? {
          metadata: Object.fromEntries(
            Object.entries(row.metadata).filter(
              ([key]) => !hiddenMetadata.includes(key),
            ),
          ),
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
  }));
}
export async function listActivity(
  p: Principal,
  params: URLSearchParams,
  options: { excludeKinds?: string[] } = {},
) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorizeAny(
      ctx,
      RECORD_RESOURCES.map((resource) => ({
        page: "activity",
        resource,
        action: "view",
      })),
    );
    const query = activityQuery(ctx, params, options);
    const { page, pageSize } = query;
    const [total] = await tx
      .select({ count: count() })
      .from(activity)
      .where(query.filter);
    const data = await activityPage(tx, query);
    return {
      data,
      pagination: {
        page,
        pageSize,
        total: total.count,
        totalPages: Math.ceil(total.count / pageSize),
      },
    };
  });
}

/**
 * One transaction; each source is included only when the caller may view it, and a source they
 * cannot view is left out rather than refused. `options.omitCandidateFields` leaves those candidate
 * fields out of the candidate search only.
 */
export async function searchWorkspace(
  p: Principal,
  query: string,
  options: { omitCandidateFields?: readonly string[] } = {},
) {
  if (query.length > 500) invalid("Search is limited to 500 characters.");
  if (!query.trim()) return { groups: [], total: 0, limited: false, data: [] };
  const groups = await withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    const groups = [];
    let limited = false;
    for (const resource of [
      "candidates",
      "vacancies",
      "job-roles",
      "tasks",
      "applications",
    ] as const) {
      if (!decide(ctx, { resource, action: "view" })) continue;
      const result = await listInside(
        tx,
        ctx,
        resource,
        new URLSearchParams({ search: query, pageSize: "8" }),
        resource === "candidates"
          ? { omitFromSearch: options.omitCandidateFields }
          : {},
      );
      limited ||= result.pagination.total > result.data.length;
      // Titles and subtitles come from the redacted rows only.
      const results = result.data.map((row) => {
        const d = row.data as Record<string, unknown>;
        return {
          id: row.id,
          kind: row.kind,
          title: String(
            d.name ||
              d.title ||
              (row.kind === "application"
                ? Object.hasOwn(d, "stage")
                  ? `Application · ${d.stage}`
                  : "Application"
                : row.kind),
          ),
          subtitle: String(d.jobTitle || d.department || d.context || ""),
          url:
            row.kind === "candidate"
              ? `/app/candidates/${row.id}`
              : `/app/${resource === "job-roles" ? "roles" : resource === "applications" ? "pipeline" : resource}?record=${row.id}`,
        };
      });
      groups.push({
        type: resource,
        label:
          resource === "job-roles"
            ? "Job roles"
            : resource[0].toUpperCase() + resource.slice(1),
        results,
      });
    }
    return { groups, limited };
  });
  return {
    groups: groups.groups,
    total: groups.groups.reduce((sum, group) => sum + group.results.length, 0),
    limited: groups.limited,
    data: groups.groups.flatMap((group) =>
      group.results.map((row) => ({ ...row, href: row.url })),
    ),
  };
}

/** Each reminder kind, the resource that views it, the fields its due date and status read. */
const DUE_KINDS: {
  kind: RecordKind;
  resource: ResourceName;
  fields: string[];
  condition: (p: Principal) => SQL;
}[] = [
  {
    kind: "task",
    resource: "tasks",
    fields: ["dueDate"],
    condition: (p) => notCompleted(p, sql`${records.bucketId}`),
  },
  {
    kind: "interview",
    resource: "interviews",
    fields: ["startAt", "status"],
    condition: () => sql`data->>'status'='Scheduled'`,
  },
  {
    kind: "offer",
    resource: "offers",
    fields: ["expiryDate", "status"],
    condition: () => sql`data->>'status'='Sent'`,
  },
  {
    kind: "checklist",
    resource: "checklist",
    fields: ["dueDate", "status"],
    condition: () => sql`data->>'status' not in('Complete','Waived')`,
  },
  {
    kind: "vacancy",
    resource: "vacancies",
    fields: ["targetDate", "status"],
    condition: () => sql`data->>'status'='Open'`,
  },
  {
    kind: "onboarding",
    resource: "onboarding",
    fields: ["startDate", "status"],
    condition: () => sql`data->>'status' in('Planned','In progress')`,
  },
];
const dueRequests = DUE_KINDS.map(({ resource }): AccessRequest => ({
  resource,
  action: "view",
}));
/**
 * The caller's current reminders: only kinds they may view whose date and status fields they may
 * see, each under its scope filter, titled only from a visible title. Null when no kind is left.
 */
function dueSource(ctx: AccessContext, now = new Date()): SQL | null {
  const { principal: p } = ctx;
  const included = DUE_KINDS.filter(
    ({ kind, resource, fields }) =>
      decide(ctx, { resource, action: "view" }) &&
      visible(ctx, kind, ...fields),
  );
  if (!included.length) return null;
  const untitled = included
    .filter(({ kind }) => !visible(ctx, kind, "title"))
    .map(({ kind }) => sql`${kind}`);
  const title = untitled.length
    ? sql`case when kind in(${sql.join(untitled, sql`,`)}) then null else data->>'title' end`
    : sql`data->>'title'`;
  const last = new Date(`${dubaiToday(now)}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 7);
  const horizon = last.toISOString().slice(0, 10);
  return sql`with possible as(select id,kind,onboarding_id as parent_id,${title} as title,
    case when kind='interview' then to_char((data->>'startAt')::timestamptz at time zone 'Asia/Dubai','YYYY-MM-DD') when kind='offer' then data->>'expiryDate' when kind='vacancy' then data->>'targetDate' when kind='onboarding' then data->>'startDate' else data->>'dueDate' end as day,
    case when kind='interview' then data->>'startAt' when kind='offer' then data->>'expiryDate' when kind='vacancy' then data->>'targetDate' when kind='onboarding' then data->>'startDate' else data->>'dueDate' end as due_value
    from ${records} where archived_at is null and private_owner_id is null and(
      ${sql.join(
        included.map(
          ({ kind, condition }) =>
            sql`(${and(...scopeFilter(ctx, kind))} and ${condition(p)})`,
        ),
        sql` or `,
      )})),
    due as(select *,kind||':'||id::text||':'||due_value as key from possible where coalesce(day,'')<>'' and day<=${horizon})`;
}
export async function notifications(p: Principal) {
  const today = dubaiToday();
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorizeAny(ctx, dueRequests);
    const due = dueSource(ctx);
    if (!due)
      return { data: [], total: 0, limited: false, unread: 0, unreadCount: 0 };
    const result = await tx.execute<{
      id: string;
      kind: string;
      parent_id: string | null;
      title: string | null;
      day: string;
      key: string;
      read: boolean;
    }>(
      sql`${due} select id,kind,parent_id,title,day,key,exists(select 1 from ${notificationReads} n where n.team_id=${p.teamId} and n.user_id=${p.userId} and n.key=due.key) as read from due order by read,day,key limit 500`,
    );
    const totals = await tx.execute<{ total: number; unread: number }>(
      sql`${due} select count(*)::int as total,count(*) filter(where not exists(select 1 from ${notificationReads} n where n.team_id=${p.teamId} and n.user_id=${p.userId} and n.key=due.key))::int as unread from due`,
    );
    const labels: Record<string, string> = {
      task: "Task due",
      interview: "Interview",
      offer: "Offer expires",
      checklist: "Onboarding item due",
      vacancy: "Vacancy target date",
      onboarding: "Onboarding starts",
    };
    const paths: Record<string, string> = {
      task: "tasks",
      interview: "interviews",
      offer: "offers",
      checklist: "onboarding",
      vacancy: "vacancies",
      onboarding: "onboarding",
    };
    const data = result.rows.map((row) => ({
      key: row.key,
      title: row.title ? `${labels[row.kind]}: ${row.title}` : labels[row.kind],
      description:
        row.day < today
          ? "Overdue"
          : row.day === today
            ? "Due today"
            : "Coming up within 7 days",
      href: `/app/${paths[row.kind]}?record=${row.kind === "checklist" ? row.parent_id : row.id}${row.kind === "checklist" ? `&checklist=${row.id}` : ""}`,
      severity: row.day < today ? ("warning" as const) : ("info" as const),
      date: row.day,
      read: row.read,
    }));
    return {
      data,
      total: totals.rows[0].total,
      limited: totals.rows[0].total > data.length,
      unread: totals.rows[0].unread,
      unreadCount: totals.rows[0].unread,
    };
  });
}
export async function markNotifications(p: Principal, keys: string[]) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorizeAny(ctx, dueRequests);
    // A fixed code rule: a token marks reminders read only with a write scope.
    if (p.authType === "token" && !ctx.scopes.includes("recruitment:write"))
      throw new ApiError(
        403,
        "scope_required",
        "Permission recruitment:write is required.",
      );
    const parsed = z.array(z.string().min(1).max(300)).max(500).safeParse(keys);
    if (!parsed.success) invalid("Select at most 500 notification keys.");
    const unique = [...new Set(parsed.data)];
    if (!unique.length) return { updated: 0 };
    // Only genuine current reminders of the kinds the caller may see can allocate read markers.
    const due = dueSource(ctx);
    if (!due) return { updated: 0 };
    const result = await tx.execute<{ key: string }>(
      sql`${due} insert into ${notificationReads}(team_id,user_id,key,read_at) select ${p.teamId},${p.userId},key,now() from due where ${inArray(sql`key`, unique)} on conflict(team_id,user_id,key) do nothing returning key`,
    );
    return { updated: result.rows.length };
  });
}
