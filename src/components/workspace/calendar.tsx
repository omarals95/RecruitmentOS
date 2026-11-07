"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  List,
  Plus,
} from "lucide-react";
import { dubaiToday, type RecordDto } from "@/domain/records";
import { RecordEditor } from "./editor";
import { useWorkspace, requestJson, humanError } from "./client";
import { dataOf, formatDate, recordLabel } from "./helpers";
import { calendarDays, interviewRangePath } from "./tab-requests";
import {
  Badge,
  EmptyState,
  LoadError,
  Loading,
  NoTeam,
  RecordDetail,
  RecordsScreen,
  type ListResponse,
} from "./records-screen";

export { calendarDays } from "./tab-requests";

function shiftDate(anchor: string, view: string, direction: number) {
  const date = new Date(`${anchor}T12:00:00Z`);
  if (view === "month") {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + direction);
  } else
    date.setUTCDate(date.getUTCDate() + direction * (view === "week" ? 7 : 1));
  return date.toISOString().slice(0, 10);
}
function eventDay(record: RecordDto) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(String(dataOf(record).startAt)));
}
/** One Dubai day's interviews by start time; equal starts are ordered by ID. */
export function interviewsOnDay(events: RecordDto[], day: string) {
  const start = (record: RecordDto) =>
    Date.parse(String(dataOf(record).startAt));
  return events
    .filter((record) => eventDay(record) === day)
    .sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
}
/** Each day's first 3 (month), 20 (week) or all (day) interviews and the count left for "+N more". */
export function calendarCells(
  events: RecordDto[],
  days: string[],
  view: "month" | "week" | "day",
) {
  const limit = view === "month" ? 3 : view === "week" ? 20 : Infinity;
  return days.map((day) => {
    const all = interviewsOnDay(events, day);
    const shown = all.slice(0, limit);
    return { day, shown, hidden: all.length - shown.length };
  });
}
/** The "+N more" button's name: the visible text first, then the day it opens. */
export function calendarMoreLabel(hidden: number, day: string): string {
  return `+${hidden} more interviews on ${formatDate(day)}`;
}
export function CalendarScreen() {
  const { team, role } = useWorkspace();
  const linkedRecord = useSearchParams().get("record");
  const [linkedError, setLinkedError] = useState("");
  const [mode, setMode] = useState<"calendar" | "list">("calendar");
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [anchor, setAnchor] = useState(dubaiToday());
  const [events, setEvents] = useState<RecordDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<{
    record?: RecordDto;
    prefill?: Record<string, unknown>;
  } | null>(null);
  const [detail, setDetail] = useState<RecordDto | null>(null);
  const days = useMemo(() => calendarDays(anchor, view), [anchor, view]);
  useEffect(() => {
    let active = true;
    if (team && linkedRecord && mode === "calendar")
      requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/interviews/${encodeURIComponent(linkedRecord)}`,
      )
        .then((response) => {
          if (active) {
            setDetail(response.data);
            setLinkedError("");
          }
        })
        .catch((error: unknown) => {
          if (active) setLinkedError(humanError(error));
        });
    return () => {
      active = false;
    };
  }, [team, linkedRecord, mode]);
  // Calendar fetch spans several pages; reset the visible loading state before starting that external request.
  useEffect(() => {
    let active = true;
    if (!team || mode !== "calendar") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize loading with the externally selected calendar range.
    setLoading(true);
    setError("");
    (async () => {
      const all: RecordDto[] = [];
      let page = 1;
      let total: number;
      do {
        const response = await requestJson<ListResponse>(
          team.id,
          interviewRangePath(days, page),
        );
        all.push(...response.data);
        total = response.pagination.totalPages;
        page++;
        if (page > 100 && page <= total)
          throw new Error(
            "This calendar range contains more than 10,000 interviews. Narrow the date range.",
          );
      } while (page <= total && active);
      if (active) setEvents(all.filter((r) => days.includes(eventDay(r))));
    })()
      .catch((e: unknown) => {
        if (active) setError(humanError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [team, days, revision, mode]);
  if (!team) return <NoTeam />;
  return (
    <div className="stack">
      {linkedError && (
        <p className="notice error" role="alert">
          The linked interview could not be opened: {linkedError}
        </p>
      )}
      <div className="row space-between calendar-mode">
        <span className="muted">Plan and review interviews</span>
        <div className="view-toggle">
          <button
            aria-pressed={mode === "calendar"}
            onClick={() => setMode("calendar")}
          >
            <CalendarDays size={17} aria-hidden="true" />
            Calendar
          </button>
          <button
            aria-pressed={mode === "list"}
            onClick={() => setMode("list")}
          >
            <List size={17} aria-hidden="true" />
            List
          </button>
        </div>
      </div>
      {mode === "list" ? (
        <RecordsScreen section="interviews" />
      ) : (
        <>
          <div className="page-heading">
            <div>
              <p className="eyebrow">Make room for a conversation</p>
              <h1>Interview calendar</h1>
              <p>All times are shown in Dubai time (UTC+4).</p>
            </div>
            <button
              className="button"
              disabled={role === "viewer"}
              onClick={() => setEditor({})}
            >
              <Plus size={17} aria-hidden="true" />
              Schedule interview
            </button>
          </div>
          <section className="panel calendar-panel">
            <div className="calendar-toolbar">
              <div className="row">
                <button
                  className="icon-button"
                  aria-label={`Previous ${view}`}
                  onClick={() =>
                    setAnchor((value) => shiftDate(value, view, -1))
                  }
                >
                  <ChevronLeft size={20} />
                </button>
                <h2>
                  {new Intl.DateTimeFormat("en-GB", {
                    month: "long",
                    year: "numeric",
                    ...(view === "day" ? { day: "numeric" } : {}),
                  }).format(new Date(`${anchor}T12:00:00Z`))}
                </h2>
                <button
                  className="icon-button"
                  aria-label={`Next ${view}`}
                  onClick={() =>
                    setAnchor((value) => shiftDate(value, view, 1))
                  }
                >
                  <ChevronRight size={20} />
                </button>
                <button
                  className="button secondary small"
                  onClick={() => setAnchor(dubaiToday())}
                >
                  Today
                </button>
              </div>
              <div className="row">
                <label className="sr-only" htmlFor="calendar-date">
                  Jump to date
                </label>
                <input
                  id="calendar-date"
                  type="date"
                  value={anchor}
                  onChange={(e) => {
                    if (e.target.value) setAnchor(e.target.value);
                  }}
                />
                <div className="view-toggle">
                  {(["month", "week", "day"] as const).map((value) => (
                    <button
                      aria-pressed={view === value}
                      key={value}
                      onClick={() => setView(value)}
                    >
                      {value[0].toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {error ? (
              <LoadError
                message={error}
                retry={() => setRevision((n) => n + 1)}
              />
            ) : loading ? (
              <Loading />
            ) : view === "day" ? (
              <div className="daily-agenda">
                {events.length ? (
                  interviewsOnDay(events, days[0]).map((record) => (
                    <button
                      className="agenda-item"
                      onClick={() => setDetail(record)}
                      key={record.id}
                    >
                      <strong>
                        {formatDate(dataOf(record).startAt, true)}
                      </strong>
                      <span>
                        <strong>{recordLabel(record)}</strong>
                        <small>
                          {String(
                            dataOf(record).interviewer ||
                              "Interviewer not recorded",
                          )}{" "}
                          · {String(dataOf(record).minutes)} minutes
                        </small>
                      </span>
                      <Badge value={dataOf(record).status} />
                    </button>
                  ))
                ) : (
                  <EmptyState
                    title="A clear day in the calendar"
                    description="There are no interviews scheduled for this date."
                  />
                )}
              </div>
            ) : (
              <div
                className={`calendar-scroll ${view === "week" ? "week-view" : ""}`}
              >
                <div className="calendar-weekdays">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
                    (day) => (
                      <span key={day}>{day}</span>
                    ),
                  )}
                </div>
                <div className="calendar-grid">
                  {calendarCells(events, days, view).map(
                    ({ day, shown, hidden }) => (
                      <div
                        className={`calendar-day ${day === dubaiToday() ? "today" : ""} ${day.slice(0, 7) !== anchor.slice(0, 7) ? "outside-month" : ""}`}
                        key={day}
                      >
                        <button
                          className="calendar-day-number"
                          onClick={() => {
                            setAnchor(day);
                            setView("day");
                          }}
                          aria-label={`View ${formatDate(day)}`}
                        >
                          {Number(day.slice(-2))}
                        </button>
                        {shown.map((record) => (
                          <button
                            className={`calendar-event ${dataOf(record).status === "Cancelled" ? "cancelled" : ""}`}
                            key={record.id}
                            onClick={() => setDetail(record)}
                          >
                            <strong>
                              {new Intl.DateTimeFormat("en-GB", {
                                timeZone: "Asia/Dubai",
                                hour: "2-digit",
                                minute: "2-digit",
                              }).format(
                                new Date(String(dataOf(record).startAt)),
                              )}
                            </strong>
                            <span>{recordLabel(record)}</span>
                          </button>
                        ))}
                        {hidden > 0 && (
                          <button
                            className="calendar-more"
                            aria-label={calendarMoreLabel(hidden, day)}
                            onClick={() => {
                              setAnchor(day);
                              setView("day");
                            }}
                          >
                            +{hidden} more
                          </button>
                        )}
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
          </section>
        </>
      )}
      {detail && (
        <RecordDetail
          key={detail.id}
          record={detail}
          onClose={() => setDetail(null)}
          onEdit={() => setEditor({ record: detail })}
          onRefresh={() => setRevision((n) => n + 1)}
          onCreate={() => {}}
          onUpdated={setDetail}
        />
      )}{" "}
      {editor && (
        <RecordEditor
          resource="interviews"
          {...editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
