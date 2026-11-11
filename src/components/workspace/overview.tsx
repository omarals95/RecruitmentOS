"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarDays,
  CheckCheck,
  Clock3,
  FileCheck2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Users,
} from "lucide-react";
import type { RecordDto, ResourceName } from "@/domain/records";
import { RecordEditor } from "./editor";
import {
  analyticsExportMetadata,
  analyticsRange,
  dataOf,
  formatDate,
  formatNumber,
  recordLabel,
  saveCsv,
} from "./helpers";
import {
  dataCache,
  teamRequester,
  useApi,
  useCacheIdentity,
  usePendingKeys,
  useWorkspace,
} from "./client";
import { markNotificationsRead } from "./optimistic";
import { useReadyTiming } from "./speed-log";
import {
  activityPath,
  analyticsPath,
  NOTIFICATIONS_PATH,
  OVERVIEW_PATH,
} from "./tab-requests";
import {
  BarChart,
  HiringMetrics,
  SeriesChart,
  type HiringMetricData,
} from "./metrics";
import {
  Badge,
  EmptyState,
  LoadError,
  Loading,
  NoTeam,
} from "./records-screen";

interface Count {
  name: string;
  count: number;
}
interface ActivityItem {
  id: string;
  recordId: string | null;
  actorId: string;
  actorName: string;
  actorType: string;
  action: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
interface OverviewData {
  counts: Record<string, number>;
  stages: Count[];
  departments: Count[];
  categories: Count[];
  upcomingInterviews: RecordDto[];
  overdueTasks: RecordDto[];
  recentActivity: ActivityItem[];
  coverage: {
    email: number;
    phone: number;
    experience: number;
    reviewRequired: number;
    total: number;
  };
  asOf: string;
  timezone: string;
}
interface AnalyticsData extends HiringMetricData {
  counts: Record<string, number>;
  stages: Count[];
  departments: Count[];
  categories: Count[];
  series: { date: string; applications: number; hired: number }[];
  offers: Count[];
  sources: Count[];
  experience: Count[];
  emirates: Count[];
  from: string;
  to: string;
  historyNote: string;
  timeToHireDays?: number | null;
  stageDurations?: { stage: string; averageDays: number; count: number }[];
}
export function Overview() {
  const { team, user, role } = useWorkspace();
  const result = useApi<OverviewData>(OVERVIEW_PATH);
  useReadyTiming("tab.overview", !!result.data);
  const [editor, setEditor] = useState<ResourceName | null>(null);
  if (!team) return <NoTeam />;
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your recruitment workspace</p>
          <h1>A clearer day starts here.</h1>
          <p>
            Welcome back, {user.name.split(" ")[0]}. Here&apos;s what&apos;s
            moving across {team.name}.
          </p>
        </div>
        <div className="row">
          <Link href="/app/candidates" className="button secondary">
            <Search size={17} aria-hidden="true" />
            Find candidates
          </Link>
          <button
            className="button"
            disabled={role === "viewer"}
            onClick={() => setEditor("vacancies")}
          >
            <Plus size={17} aria-hidden="true" />
            Create vacancy
          </button>
        </div>
      </div>
      {result.error ? (
        <LoadError message={result.error} retry={result.refresh} />
      ) : result.loading ? (
        <Loading />
      ) : (
        result.data && (
          <>
            <div className="stat-grid">
              <Stat
                label="Candidates"
                value={result.data.counts.candidates}
                icon={Users}
                href="/app/candidates"
                caption="Your team’s talent directory"
              />
              <Stat
                label="Open vacancies"
                value={result.data.counts.vacancies}
                icon={BriefcaseBusiness}
                href="/app/vacancies"
                caption="Vacancies with status Open"
              />
              <Stat
                label="Applications"
                value={result.data.counts.applications}
                icon={FileCheck2}
                href="/app/pipeline"
                caption="Nonarchived application records"
              />
              <Stat
                label="Team tasks"
                value={result.data.counts.tasks}
                icon={CheckCheck}
                href="/app/tasks"
                caption="Tasks not in a completed bucket"
              />
            </div>
            <div className="data-reconciliation">
              <span>
                <strong>{formatNumber(result.data.counts.candidates)}</strong>{" "}
                candidate records
              </span>
              <span>
                <strong>
                  {result.data.counts.cvFiles === undefined
                    ? "—"
                    : formatNumber(result.data.counts.cvFiles)}
                </strong>{" "}
                private CV files
              </span>
              <span>
                <strong>
                  {result.data.counts.candidatesWithCvs === undefined
                    ? "—"
                    : formatNumber(result.data.counts.candidatesWithCvs)}
                </strong>{" "}
                candidates with CVs
              </span>
              <Link href="/app/insights">
                Review data coverage
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
            <div className="dashboard-grid">
              <section className="panel pipeline-panel">
                <PanelHeading
                  title="Your recruitment pipeline"
                  description="Current application stages"
                  href="/app/pipeline"
                />
                <BarChart
                  data={result.data.stages}
                  empty="Add applications to see your pipeline take shape."
                />
                <p className="panel-footnote">
                  Stages are manually maintained. Task buckets and offer
                  statuses are tracked independently.
                </p>
              </section>
              <section className="panel">
                <PanelHeading
                  title="Upcoming interviews"
                  description="Your next conversations"
                  href="/app/interviews"
                />
                {result.data.upcomingInterviews.length ? (
                  <div className="agenda-list">
                    {result.data.upcomingInterviews
                      .slice(0, 5)
                      .map((record) => (
                        <Link
                          className="agenda-item"
                          href={`/app/interviews?record=${record.id}`}
                          key={record.id}
                        >
                          <span className="agenda-date">
                            <CalendarDays size={21} aria-hidden="true" />
                          </span>
                          <span>
                            <strong>{recordLabel(record)}</strong>
                            <small>
                              {formatDate(dataOf(record).startAt, true)}
                            </small>
                          </span>
                          <ArrowUpRight size={16} aria-hidden="true" />
                        </Link>
                      ))}
                  </div>
                ) : (
                  <EmptyState
                    title="A little room in the calendar"
                    description="Scheduled interviews will appear here."
                    action={
                      <Link href="/app/interviews" className="text-link">
                        Plan an interview
                        <ArrowRight size={16} aria-hidden="true" />
                      </Link>
                    }
                  />
                )}
              </section>
            </div>
            <div className="dashboard-grid three-columns">
              <section className="panel">
                <PanelHeading
                  title="Needs your attention"
                  description="Tasks past their due date"
                  href="/app/tasks"
                />
                {result.data.overdueTasks.length ? (
                  <div className="agenda-list">
                    {result.data.overdueTasks.slice(0, 5).map((record) => (
                      <Link
                        className="agenda-item"
                        key={record.id}
                        href={`/app/tasks?record=${record.id}`}
                      >
                        <span className="agenda-date warning">
                          <Clock3 size={20} aria-hidden="true" />
                        </span>
                        <span>
                          <strong>{recordLabel(record)}</strong>
                          <small>
                            Due {formatDate(dataOf(record).dueDate)}
                          </small>
                        </span>
                        <ArrowUpRight size={16} aria-hidden="true" />
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="calm-empty">
                    <CheckCheck size={27} aria-hidden="true" />
                    <h3>You&apos;re up to date</h3>
                    <p>No overdue tasks to chase.</p>
                  </div>
                )}
              </section>
              <section className="panel">
                <PanelHeading
                  title="Talent pool coverage"
                  description="Source facts, without assumptions"
                  href="/app/insights"
                />
                <Coverage coverage={result.data.coverage} />
              </section>
              <section className="panel">
                <PanelHeading
                  title="Recent activity"
                  description="The latest from your team"
                  href="/app/activity"
                />
                {result.data.recentActivity.length ? (
                  <div className="activity-mini">
                    {result.data.recentActivity.slice(0, 5).map((item) => (
                      <div key={item.id}>
                        <span className="timeline-dot" />
                        <strong>{item.summary}</strong>
                        <small>
                          {item.actorName || item.actorType} ·{" "}
                          {formatDate(item.createdAt, true)}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="calm-empty">
                    <Activity size={27} aria-hidden="true" />
                    <h3>A fresh workspace</h3>
                    <p>Team updates appear as records are saved.</p>
                  </div>
                )}
              </section>
            </div>
            <div className="as-of">
              <ShieldCheck size={15} aria-hidden="true" />
              Team-scoped records · Updated {formatDate(
                result.data.asOf,
                true,
              )}{" "}
              · Asia/Dubai
            </div>
          </>
        )
      )}
      {editor && (
        <RecordEditor
          resource={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            result.refresh();
          }}
        />
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  icon: Icon,
  href,
  caption,
}: {
  label: string;
  value: number | undefined;
  icon: typeof Users;
  href: string;
  caption: string;
}) {
  return (
    <Link className="stat-card" href={href}>
      <div className="row space-between">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon size={19} aria-hidden="true" />
        </span>
      </div>
      <strong className="stat-value">
        {typeof value === "number" ? formatNumber(value) : "—"}
      </strong>
      <div className="row space-between">
        <small>{caption}</small>
        <ArrowUpRight size={16} aria-hidden="true" />
      </div>
    </Link>
  );
}
function PanelHeading({
  title,
  description,
  href,
}: {
  title: string;
  description?: string;
  href?: string;
}) {
  return (
    <div className="panel-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {href && (
        <Link
          className="icon-button"
          href={href}
          aria-label={`View ${title.toLowerCase()}`}
        >
          <ArrowUpRight size={18} />
        </Link>
      )}
    </div>
  );
}
function Coverage({ coverage }: { coverage: OverviewData["coverage"] }) {
  const rows = [
    { name: "Email recorded", count: coverage.email },
    { name: "Phone recorded", count: coverage.phone },
    { name: "Experience recorded", count: coverage.experience },
  ];
  return (
    <div className="coverage-list">
      {rows.map((row) => (
        <div key={row.name}>
          <div className="row space-between">
            <span>{row.name}</span>
            <strong>
              {formatNumber(row.count)} / {formatNumber(coverage.total)}
            </strong>
          </div>
          <progress
            aria-label={row.name}
            value={row.count}
            max={coverage.total || 1}
          />
        </div>
      ))}
      <Link className="coverage-review" href="/app/source-review">
        <span>Source records needing review</span>
        <strong>
          {formatNumber(coverage.reviewRequired)}
          <ArrowUpRight size={15} aria-hidden="true" />
        </strong>
      </Link>
    </div>
  );
}
export function Analytics({ talent = false }: { talent?: boolean }) {
  const { team, environment } = useWorkspace();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dates, setDates] = useState({ from: "", to: "" });
  const result = useApi<AnalyticsData>(analyticsPath(dates.from, dates.to));
  useReadyTiming(talent ? "tab.insights" : "tab.analytics", !!result.data);
  const overview = useApi<OverviewData>(talent ? OVERVIEW_PATH : null);
  if (!team) return <NoTeam />;
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {talent ? "Know your talent pool" : "Recruitment intelligence"}
          </p>
          <h1>{talent ? "Talent insights" : "Hiring analytics"}</h1>
          <p>
            {talent
              ? "Understand the facts you have, and the information still to collect."
              : "A factual view of your recruitment activity and observed outcomes."}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={!result.data}
          onClick={() => {
            if (!result.data) return;
            const now = new Date();
            saveCsv(
              "RecruitmentOS-analytics.csv",
              ["Metric", "Group", "Count"],
              [
                ...result.data.stages.map((item) => [
                  "Application stage",
                  item.name,
                  item.count,
                ]),
                ...result.data.sources.map((item) => [
                  "Application source",
                  item.name,
                  item.count,
                ]),
                ...result.data.series.flatMap((item) => [
                  ["Applications", item.date, item.applications],
                  ["Observed hires", item.date, item.hired],
                ]),
              ],
              analyticsExportMetadata({
                title: talent ? "Talent insights" : "Hiring analytics",
                from: result.data.from,
                to: result.data.to,
                now,
                environment,
              }),
            );
          }}
        >
          Export statistics
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
      </div>
      {!talent && (
        <form
          className="panel date-filter"
          onSubmit={(e) => {
            e.preventDefault();
            setDates({ from, to });
          }}
        >
          <div className="field">
            <label htmlFor="analytics-from">Observed activity from</label>
            <input
              id="analytics-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="analytics-to">Observed activity to</label>
            <input
              id="analytics-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <button className="button">Apply date range</button>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
              setDates({ from: "", to: "" });
            }}
          >
            Last 30 days
          </button>
        </form>
      )}
      {!talent && result.data && (
        <p className="muted">
          {analyticsRange(result.data.from, result.data.to)}
        </p>
      )}
      {result.error ? (
        <LoadError message={result.error} retry={result.refresh} />
      ) : result.loading ? (
        <Loading />
      ) : (
        result.data && (
          <>
            {talent ? (
              <>
                <div className="stat-grid">
                  <Stat
                    label="Candidate records"
                    value={result.data.counts.candidates}
                    icon={Users}
                    href="/app/candidates"
                    caption="Current team directory"
                  />
                  <Stat
                    label="My shortlist"
                    value={overview.data?.counts.shortlisted}
                    icon={Star}
                    href="/app/shortlist"
                    caption="Your personal saved candidates"
                  />
                  <Stat
                    label="Source categories"
                    value={result.data.categories.length}
                    icon={BriefcaseBusiness}
                    href="/app/candidates"
                    caption="Derived from original folders"
                  />
                  <Stat
                    label="Needs source review"
                    value={overview.data?.coverage.reviewRequired}
                    icon={FileCheck2}
                    href="/app/source-review"
                    caption="Review facts before relying on them"
                  />
                </div>
                <div className="dashboard-grid">
                  <section className="panel">
                    <PanelHeading
                      title="Folder-derived categories"
                      description="A candidate can have several source folder tags"
                    />
                    <BarChart data={result.data.categories} />
                  </section>
                  <section className="panel">
                    <PanelHeading
                      title="CV-stated experience"
                      description="Missing experience remains unknown"
                    />
                    <BarChart data={result.data.experience} />
                  </section>
                  <section className="panel">
                    <PanelHeading
                      title="Residence emirate"
                      description="As explicitly recorded in source documents"
                    />
                    <BarChart data={result.data.emirates} />
                  </section>
                  <section className="panel">
                    <PanelHeading title="Contact & experience coverage" />
                    {overview.data ? (
                      <Coverage coverage={overview.data.coverage} />
                    ) : overview.error ? (
                      <p role="alert">{overview.error}</p>
                    ) : (
                      <Loading />
                    )}
                  </section>
                </div>
              </>
            ) : (
              <>
                <div className="stat-grid">
                  <Stat
                    label="Applications"
                    value={result.data.counts.applications}
                    icon={Users}
                    href="/app/pipeline"
                    caption="Current active application records"
                  />
                  <Stat
                    label="Open vacancies"
                    value={result.data.counts.vacancies}
                    icon={BriefcaseBusiness}
                    href="/app/vacancies"
                    caption="Currently open roles"
                  />
                  <Stat
                    label="Offers"
                    value={result.data.counts.offers}
                    icon={FileCheck2}
                    href="/app/offers"
                    caption="Offer records in your team"
                  />
                  <Stat
                    label="Onboarding"
                    value={result.data.counts.onboarding}
                    icon={ShieldCheck}
                    href="/app/onboarding"
                    caption="Onboarding records in your team"
                  />
                </div>
                <div className="dashboard-grid">
                  <section className="panel">
                    <PanelHeading
                      title="Applications by current stage"
                      description="Current nonarchived application records"
                    />
                    <BarChart data={result.data.stages} />
                  </section>
                  <section className="panel">
                    <PanelHeading title="Application sources" />
                    <BarChart data={result.data.sources} />
                  </section>
                  <section className="panel">
                    <PanelHeading
                      title="Offer outcomes"
                      description="Independent of application stage"
                    />
                    <BarChart data={result.data.offers} />
                  </section>
                  <section className="panel">
                    <PanelHeading
                      title="Open roles by department"
                      description="Vacancies with status Open"
                    />
                    <BarChart data={result.data.departments} />
                  </section>
                </div>
                <section className="panel">
                  <PanelHeading
                    title="Application & hiring activity"
                    description="Recorded application creation and first observed Hired transitions"
                  />
                  <SeriesChart rows={result.data.series} />
                </section>
                <HiringMetrics data={result.data} />
              </>
            )}
            <p className="notice">
              {result.data.historyNote ||
                "Analytics use recorded facts and observed stage history. Imported records do not invent past transitions. Source categories can overlap, so category totals can exceed the number of candidates."}
            </p>
          </>
        )
      )}
    </div>
  );
}
type ActivityPage = {
  data: ActivityItem[];
  pagination: { total: number; totalPages: number };
};
/** The activity feed's search, record type and page, and its read of the active or TeamScope team. */
function useActivity() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const result = useApi<ActivityPage>(activityPath(page, search, kind));
  return { search, setSearch, kind, setKind, page, setPage, result };
}
export function ActivityScreen() {
  const { team } = useWorkspace();
  const activity = useActivity();
  useReadyTiming("tab.activity", !!activity.result.data);
  if (!team) return <NoTeam />;
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your team, in motion</p>
          <h1>Activity</h1>
          <p>
            A traceable record of changes across your recruitment workspace.
          </p>
        </div>
        <button className="button secondary" onClick={activity.result.refresh}>
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </div>
      <ActivityPanel {...activity} />
    </div>
  );
}
/** The team detail Activity tab: the same feed as /app/activity, for the TeamScope's team. */
export function ActivityList() {
  const activity = useActivity();
  return <ActivityPanel heading="Activity" {...activity} />;
}
/** The activity feed with its search, record-type filter and paging, 50 events a page. */
function ActivityPanel({
  heading,
  search,
  setSearch,
  kind,
  setKind,
  page,
  setPage,
  result,
}: ReturnType<typeof useActivity> & { heading?: string }) {
  return (
    <section className="panel">
      {heading && <h2>{heading}</h2>}
      <div className="records-toolbar">
        <div className="search-field">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Search activity"
            placeholder="Search activity…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          aria-label="Filter activity by record type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All record types</option>
          {[
            "candidate",
            "vacancy",
            "application",
            "task",
            "interview",
            "offer",
            "onboarding",
            "checklist",
            "comment",
            "export",
          ].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      {result.error ? (
        <LoadError message={result.error} retry={result.refresh} />
      ) : result.loading ? (
        <Loading />
      ) : result.data?.data.length ? (
        <div className="activity-feed">
          {result.data.data.map((item) => (
            <article key={item.id}>
              <span className="activity-icon">
                <Activity size={18} aria-hidden="true" />
              </span>
              <div>
                <p>
                  <strong>{item.actorName || item.actorType}</strong>
                  <span className="badge">{item.kind}</span>
                </p>
                <h3>{item.summary}</h3>
                <p className="muted">
                  {formatDate(item.createdAt, true)} · {item.actorType}
                  {item.action === "import" ? " · Imported source record" : ""}
                </p>
                {item.metadata.fromStage && item.metadata.toStage ? (
                  <p>
                    <Badge value={item.metadata.fromStage} /> →{" "}
                    <Badge value={item.metadata.toStage} />
                  </p>
                ) : null}
                {item.metadata.fromStatus && item.metadata.toStatus ? (
                  <p>
                    <Badge value={item.metadata.fromStatus} /> →{" "}
                    <Badge value={item.metadata.toStatus} />
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="Your team’s story starts here"
          description="Saved changes and workflow updates appear in this audit trail."
        />
      )}
      <div className="pagination">
        <span>{result.data?.pagination.total || 0} events</span>
        <div className="row">
          <button
            className="button secondary small"
            disabled={page === 1}
            onClick={() => setPage((n) => n - 1)}
          >
            Previous
          </button>
          <span>Page {page}</span>
          <button
            className="button secondary small"
            disabled={page >= (result.data?.pagination.totalPages || 1)}
            onClick={() => setPage((n) => n + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
interface NotificationItem {
  key: string;
  title: string;
  description: string;
  href: string;
  severity: "info" | "warning";
  date: string;
  read: boolean;
}
export function Notifications() {
  const { team } = useWorkspace();
  const result = useApi<{
    data: NotificationItem[];
    unread: number;
    unreadCount?: number;
    total?: number;
    limited?: boolean;
  }>(NOTIFICATIONS_PATH);
  useReadyTiming("tab.notifications", !!result.data);
  const identity = useCacheIdentity();
  const [show, setShow] = useState("all");
  const [error, setError] = useState("");
  const busy = usePendingKeys().has(NOTIFICATIONS_PATH);
  // Read at once here and in the navigation count; undone with a message if the save fails.
  const mark = (keys: string[]) => {
    if (!team || !identity || busy) return;
    setError("");
    void markNotificationsRead(dataCache, teamRequester(team.id), {
      identity,
      path: NOTIFICATIONS_PATH,
      keys,
    }).then((outcome) => {
      if (!outcome.ok && outcome.message) setError(outcome.message);
    });
  };
  if (!team) return <NoTeam />;
  const items =
    result.data?.data.filter((item) => show !== "unread" || !item.read) || [];
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Stay one step ahead</p>
          <h1>
            Notifications
            {result.data && (
              <span className="heading-count">{result.data.unread} unread</span>
            )}
          </h1>
          <p>
            Upcoming interviews, due tasks, expiring offers and onboarding
            reminders.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy || !result.data?.unread}
          onClick={() =>
            mark(
              result
                .data!.data.filter((item) => !item.read)
                .map((item) => item.key),
            )
          }
        >
          <CheckCheck size={17} aria-hidden="true" />
          Mark visible as read
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        {result.data?.limited && (
          <p className="notice">
            Showing {result.data.data.length} of {result.data.total} reminders.
            Mark visible unread reminders as read, then refresh to load more.
          </p>
        )}
        <div className="tabs">
          <button aria-pressed={show === "all"} onClick={() => setShow("all")}>
            All reminders
          </button>
          <button
            aria-pressed={show === "unread"}
            onClick={() => setShow("unread")}
          >
            Unread
          </button>
        </div>
        {result.error ? (
          <LoadError message={result.error} retry={result.refresh} />
        ) : result.loading ? (
          <Loading />
        ) : items.length ? (
          <div className="notification-list">
            {items.map((item) => (
              <article
                className={`notification-item ${item.read ? "read" : ""}`}
                key={item.key}
              >
                <span className={`notification-status ${item.severity}`}>
                  <Clock3 size={21} aria-hidden="true" />
                </span>
                <div>
                  <Link href={item.href}>
                    <h3>{item.title}</h3>
                  </Link>
                  <p>{item.description}</p>
                  <small>{formatDate(item.date, true)}</small>
                </div>
                <div className="row">
                  {!item.read && (
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() => mark([item.key])}
                    >
                      Mark read
                    </button>
                  )}
                  <Link
                    className="icon-button"
                    href={item.href}
                    aria-label={`Open ${item.title}`}
                  >
                    <ArrowUpRight size={19} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing needs your attention right now"
            description="New reminders appear here when interviews, tasks and milestones are coming up."
          />
        )}
      </section>
      <p className="muted">
        Reminders appear in this app. RecruitmentOS does not send recruitment
        messages to candidates automatically.
      </p>
    </div>
  );
}
