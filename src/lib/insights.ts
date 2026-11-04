import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
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
import { withTeam } from "./db-team";
import type { Principal } from "./principal";
import { requireScope } from "./permissions";
import { ApiError } from "./errors";
import {
  APPLICATION_STAGES,
  daySchema,
  dubaiToday,
  resourceToKind,
  type RecordDto,
} from "@/domain/records";
import { listRecords } from "./records";

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
function active(p: Principal, kind?: string) {
  return and(
    eq(records.teamId, p.teamId),
    isNull(records.archivedAt),
    isNull(records.privateOwnerId),
    ...(kind ? [eq(records.kind, kind)] : []),
  );
}
function asDto(row: typeof records.$inferSelect): RecordDto {
  const { teamId: _teamId, createdAt, updatedAt, archivedAt, ...rest } = row;
  return {
    ...rest,
    data: row.data as RecordDto["data"],
    kind: row.kind as RecordDto["kind"],
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    archivedAt: archivedAt?.toISOString() ?? null,
  };
}
async function inventory(tx: TeamTx, p: Principal) {
  const [counts] = await tx
    .select({
      candidates: sql<number>`count(*) filter(where ${records.kind}='candidate')::int`,
      vacancies: sql<number>`count(*) filter(where ${records.kind}='vacancy' and ${records.data}->>'status'='Open')::int`,
      applications: sql<number>`count(*) filter(where ${records.kind}='application')::int`,
      tasks: sql<number>`count(*) filter(where ${records.kind}='task')::int`,
      interviews: sql<number>`count(*) filter(where ${records.kind}='interview' and ${records.data}->>'status'='Scheduled')::int`,
      offers: sql<number>`count(*) filter(where ${records.kind}='offer')::int`,
      onboarding: sql<number>`count(*) filter(where ${records.kind}='onboarding' and ${records.data}->>'status'<>'Completed')::int`,
    })
    .from(records)
    .where(active(p));
  return counts;
}
async function stages(tx: TeamTx, p: Principal): Promise<Count[]> {
  const rows = await tx
    .select({ name: sql<string>`${records.data}->>'stage'`, count: count() })
    .from(records)
    .where(active(p, "application"))
    .groupBy(sql`${records.data}->>'stage'`);
  return APPLICATION_STAGES.map((name) => ({
    name,
    count: rows.find((row) => row.name === name)?.count ?? 0,
  }));
}
async function grouped(
  tx: TeamTx,
  p: Principal,
  kind: string,
  field: string,
  array = false,
): Promise<Count[]> {
  // Aggregate in PostgreSQL; do not load candidate texts, comments or notes.
  const statusFilter =
    field === "declineReason" ? sql`and r.data->>'status'='Declined'` : sql``;
  const source = array
    ? sql`select distinct r.id, coalesce(nullif(btrim(tag.value),''),'Not recorded') as name from ${records} r
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(r.data->${field})='array' and r.data->${field}<>'[]'::jsonb then r.data->${field} else '["Not recorded"]'::jsonb end) tag(value)
        where r.team_id=${p.teamId} and r.kind=${kind} and r.archived_at is null and r.private_owner_id is null ${statusFilter}`
    : sql`select coalesce(nullif(btrim(r.data->>${field}),''),'Not recorded') as name from ${records} r where r.team_id=${p.teamId} and r.kind=${kind} and r.archived_at is null and r.private_owner_id is null ${statusFilter}`;
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
  requireScope(p, "candidates:read");
  requireScope(p, "recruitment:read");
  const now = new Date(),
    today = dubaiToday(now);
  const result = await withTeam(p, async (tx) => {
    const counts = await inventory(tx, p);
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
          eq(records.kind, "candidate"),
          isNull(records.archivedAt),
        ),
      );
    const [coverage] = await tx
      .select({
        email: sql<number>`count(*) filter(where coalesce(${records.data}->>'email','')<>'')::int`,
        phone: sql<number>`count(*) filter(where coalesce(${records.data}->>'phone','')<>'')::int`,
        experience: sql<number>`count(*) filter(where jsonb_typeof(${records.data}->'yearsExperience')='number')::int`,
        reviewRequired: sql<number>`count(*) filter(where coalesce(${records.data}->>'reviewStatus','') !~* '^(verified|reviewed|complete|completed)$')::int`,
        total: count(),
      })
      .from(records)
      .where(active(p, "candidate"));
    let cvCounts: {
      cvFiles?: number;
      pendingCvs?: number;
      candidatesWithCvs?: number;
    } = {};
    if (p.scopes.includes("cvs:read")) {
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
            eq(records.kind, "candidate"),
            isNull(records.archivedAt),
          ),
        );
    }
    const upcoming = await tx
      .select()
      .from(records)
      .where(
        and(
          active(p, "interview"),
          sql`${records.data}->>'status'='Scheduled'`,
          sql`(${records.data}->>'startAt')::timestamptz>=${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(
        asc(sql`(${records.data}->>'startAt')::timestamptz`),
        asc(records.id),
      )
      .limit(6);
    const overdue = await tx
      .select()
      .from(records)
      .where(
        and(
          active(p, "task"),
          sql`coalesce(${records.data}->>'dueDate','')<>''`,
          sql`${records.data}->>'dueDate'<${today}`,
        ),
      )
      .orderBy(asc(sql`${records.data}->>'dueDate'`), asc(records.id))
      .limit(6);
    return {
      counts: { ...counts, shortlisted: shortlisted.count, ...cvCounts },
      coverage,
      stages: await stages(tx, p),
      departments: await grouped(tx, p, "vacancy", "department"),
      categories: await grouped(tx, p, "candidate", "folderCategories", true),
      upcomingInterviews: upcoming.map(asDto),
      overdueTasks: overdue.map(asDto),
    };
  });
  return {
    ...result,
    recentActivity: (
      await listActivity(p, new URLSearchParams({ pageSize: "8" }))
    ).data,
    asOf: now.toISOString(),
    timezone: "Asia/Dubai",
  };
}

function observedEvents(p: Principal, end: string) {
  return sql`select record_id,created_at,id,action,metadata->>'toStage' as to_stage,metadata->>'fromStage' as from_stage
    from ${activity} where team_id=${p.teamId} and kind='application' and actor_type<>'import' and created_at<=${end}::timestamptz
    and jsonb_typeof(metadata->'toStage')='string'`;
}
export async function analytics(p: Principal, params: URLSearchParams) {
  requireScope(p, "candidates:read");
  requireScope(p, "recruitment:read");
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
  return withTeam(p, async (tx) => {
    const observed = observedEvents(p, end);
    const daily = await tx.execute<{
      date: string;
      applications: number;
      hired: number;
    }>(sql`with events as(${observed}), first_hires as(select record_id,min(created_at) as at from events where to_stage='Hired' group by record_id), daily as(
      select to_char(created_at at time zone 'Asia/Dubai','YYYY-MM-DD') as day,count(*)::int as applications,0::int as hired from events where action='created' and created_at>=${start}::timestamptz group by day
      union all select to_char(at at time zone 'Asia/Dubai','YYYY-MM-DD') as day,0::int,count(*)::int from first_hires where at>=${start}::timestamptz group by day)
      select day as date,sum(applications)::int as applications,sum(hired)::int as hired from daily group by day`);
    const durationRows = await tx.execute<{
      stage: string;
      averageDays: number;
      count: number;
    }>(sql`with events as(${observed}), transitions as(select *,lag(to_stage) over(partition by record_id order by created_at,id) as previous_stage,lag(created_at) over(partition by record_id order by created_at,id) as previous_at from events)
      select previous_stage as stage,avg(extract(epoch from(created_at-previous_at))/86400)::float8 as "averageDays",count(*)::int as count from transitions where previous_stage=from_stage and created_at>=previous_at and created_at>=${start}::timestamptz group by previous_stage`);
    const hireRows = await tx.execute<{
      hiresCount: number;
      timeToHireDays: number | null;
      timeToHireSample: number;
    }>(sql`with events as(${observed}), per_application as(select record_id,min(created_at) filter(where action='created') as born,min(created_at) filter(where to_stage='Hired') as hired from events group by record_id)
      select count(*)::int as "hiresCount",avg(extract(epoch from(hired-born))/86400) filter(where born is not null and hired>=born)::float8 as "timeToHireDays",count(*) filter(where born is not null and hired>=born)::int as "timeToHireSample" from per_application where hired>=${start}::timestamptz`);
    const conversionRows = await tx.execute<{
      stage: string;
      count: number;
      denominator: number;
    }>(
      sql`with events as(${observed}) select to_stage as stage,count(distinct record_id)::int as count,(select count(distinct record_id)::int from events) as denominator from events group by to_stage`,
    );
    const experienceRows = await tx.execute<{ name: string; count: number }>(
      sql`select band as name,count(*)::int as count from(select case when jsonb_typeof(data->'yearsExperience')<>'number' or data->'yearsExperience' is null then 'Not recorded' when (data->>'yearsExperience')::numeric<3 then '0-2 years' when(data->>'yearsExperience')::numeric<6 then '3-5 years' when(data->>'yearsExperience')::numeric<11 then '6-10 years' else '11+ years' end as band from ${records} where team_id=${p.teamId} and kind='candidate' and archived_at is null) bands group by band`,
    );
    const series = [];
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
    return {
      counts: await inventory(tx, p),
      stages: await stages(tx, p),
      departments: await grouped(tx, p, "vacancy", "department"),
      categories: await grouped(tx, p, "candidate", "folderCategories", true),
      series,
      offers: await grouped(tx, p, "offer", "status"),
      declineReasons: await grouped(tx, p, "offer", "declineReason"),
      sources: await grouped(tx, p, "application", "source"),
      experience: [
        "Not recorded",
        "0-2 years",
        "3-5 years",
        "6-10 years",
        "11+ years",
      ].map((name) => ({
        name,
        count: experienceRows.rows.find((row) => row.name === name)?.count ?? 0,
      })),
      emirates: await grouped(tx, p, "candidate", "residenceEmirate"),
      from,
      to,
      ...hireRows.rows[0],
      stageDurations: APPLICATION_STAGES.map(
        (stage) =>
          durationRows.rows.find((row) => row.stage === stage) ?? {
            stage,
            averageDays: null,
            count: 0,
          },
      ),
      conversions: APPLICATION_STAGES.map((stage) => {
        const row = conversionRows.rows.find((item) => item.stage === stage);
        const denominator = conversionRows.rows[0]?.denominator ?? 0;
        return {
          stage,
          count: row?.count ?? 0,
          rate: denominator ? (row?.count ?? 0) / denominator : null,
        };
      }),
      historyNote:
        "Inventory charts show current active records. Dated series and first hires use changes observed by RecruitmentOS in Asia/Dubai; imported records do not invent past applications or hires. Time to hire requires an observed creation and first hire. Stage durations require observed entries and exits. Conversion is the all-observed-history share reaching each stage through the end date. Categories reproduce source folders, not suitability assessments. Category charts show the first 100 groups plus the combined remainder.",
    };
  });
}

export async function listActivity(p: Principal, params: URLSearchParams) {
  requireScope(p, "recruitment:read");
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
      .enum([...Object.values(resourceToKind), "cv", "api-token"])
      .safeParse(kind).success
  )
    invalid("Unsupported activity record type.");
  return withTeam(p, async (tx) => {
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
    const filter = and(
      eq(activity.teamId, p.teamId),
      ...(recordId ? [eq(activity.recordId, recordId)] : []),
      sql`(${activity.action}<>'personal_state_updated' or ${activity.actorId}=${p.userId})`,
      sql`(${activity.kind}<>'saved-view' or ${activity.actorId}=${p.userId})`,
      ...(!p.scopes.includes("candidates:read")
        ? [sql`${activity.kind}<>'candidate'`]
        : []),
      ...(kind ? [eq(activity.kind, kind)] : []),
      ...searchFilter,
    );
    const [total] = await tx
      .select({ count: count() })
      .from(activity)
      .where(filter);
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
    return {
      data: data.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        total: total.count,
        totalPages: Math.ceil(total.count / pageSize),
      },
    };
  });
}

export async function searchWorkspace(p: Principal, query: string) {
  if (query.length > 500) invalid("Search is limited to 500 characters.");
  if (!query.trim()) return { groups: [], total: 0, limited: false, data: [] };
  const groups = [];
  let limited = false;
  for (const resource of [
    "candidates",
    "vacancies",
    "job-roles",
    "tasks",
    "applications",
  ] as const) {
    if (
      !p.scopes.includes(
        resource === "candidates" ? "candidates:read" : "recruitment:read",
      )
    )
      continue;
    const result = await listRecords(
      p,
      resource,
      new URLSearchParams({ search: query, pageSize: "8" }),
    );
    limited ||= result.pagination.total > result.data.length;
    const results = result.data.map((row) => {
      const d = row.data as Record<string, unknown>;
      return {
        id: row.id,
        kind: row.kind,
        title: String(
          d.name ||
            d.title ||
            (row.kind === "application"
              ? `Application · ${d.stage}`
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
  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.results.length, 0),
    limited,
    data: groups.flatMap((group) =>
      group.results.map((row) => ({ ...row, href: row.url })),
    ),
  };
}

function dueSource(p: Principal, now = new Date()): SQL {
  const last = new Date(`${dubaiToday(now)}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 7);
  const horizon = last.toISOString().slice(0, 10);
  return sql`with possible as(select id,kind,onboarding_id as parent_id,data->>'title' as title,
    case when kind='interview' then to_char((data->>'startAt')::timestamptz at time zone 'Asia/Dubai','YYYY-MM-DD') when kind='offer' then data->>'expiryDate' when kind='vacancy' then data->>'targetDate' when kind='onboarding' then data->>'startDate' else data->>'dueDate' end as day,
    case when kind='interview' then data->>'startAt' when kind='offer' then data->>'expiryDate' when kind='vacancy' then data->>'targetDate' when kind='onboarding' then data->>'startDate' else data->>'dueDate' end as due_value
    from ${records} where team_id=${p.teamId} and archived_at is null and private_owner_id is null and(
      kind='task' or(kind='interview' and data->>'status'='Scheduled') or(kind='offer' and data->>'status'='Sent') or(kind='checklist' and data->>'status' not in('Complete','Waived')) or(kind='vacancy' and data->>'status'='Open') or(kind='onboarding' and data->>'status' in('Planned','In progress')))),
    due as(select *,kind||':'||id::text||':'||due_value as key from possible where coalesce(day,'')<>'' and day<=${horizon})`;
}
export async function notifications(p: Principal) {
  requireScope(p, "recruitment:read");
  const today = dubaiToday();
  return withTeam(p, async (tx) => {
    const due = dueSource(p);
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
  requireScope(p, "recruitment:read");
  if (p.authType === "token") requireScope(p, "recruitment:write");
  const parsed = z.array(z.string().min(1).max(300)).max(500).safeParse(keys);
  if (!parsed.success) invalid("Select at most 500 notification keys.");
  const unique = [...new Set(parsed.data)];
  if (!unique.length) return { updated: 0 };
  return withTeam(p, async (tx) => {
    // Only genuine current reminders can allocate personal read markers.
    const result = await tx.execute<{ key: string }>(
      sql`${dueSource(p)} insert into ${notificationReads}(team_id,user_id,key,read_at) select ${p.teamId},${p.userId},key,now() from due where ${inArray(sql`key`, unique)} on conflict(team_id,user_id,key) do nothing returning key`,
    );
    return { updated: result.rows.length };
  });
}
