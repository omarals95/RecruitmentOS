"use client";

import { useState } from "react";
import { useApi } from "./client";
import { OFFER_STATS_PATH } from "./tab-requests";
import { formatDate, formatNumber } from "./helpers";

interface Count {
  name: string;
  count: number;
}
export function BarChart({
  data,
  empty = "No data recorded yet.",
}: {
  data: Count[];
  empty?: string;
}) {
  const max = Math.max(1, ...data.map((item) => item.count));
  return data.some((item) => item.count > 0) ? (
    <div
      className="bar-chart"
      role="img"
      aria-label={data.map((item) => `${item.name}: ${item.count}`).join(", ")}
    >
      {data.map((item, index) => (
        <div className="bar-row" key={item.name}>
          <span>{item.name}</span>
          <div>
            <span
              style={{ width: `${(item.count / max) * 100}%` }}
              className={`bar-color-${index % 5}`}
            />
          </div>
          <strong>{formatNumber(item.count)}</strong>
        </div>
      ))}
    </div>
  ) : (
    <p className="chart-empty">{empty}</p>
  );
}

export interface HiringMetricData {
  timeToHireDays?: number | null;
  timeToHireSample?: number;
  hiresCount?: number;
  stageDurations?: {
    stage: string;
    averageDays: number | null;
    count: number;
  }[];
  conversions?: { stage: string; count: number; rate: number | null }[];
}
export function HiringMetrics({ data }: { data: HiringMetricData }) {
  return (
    <div className="dashboard-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Observed creation-to-hire time</h2>
            <p>
              Records with a known creation event and first Hired transition
            </p>
          </div>
        </div>
        <div className="hiring-time">
          <strong>
            {typeof data.timeToHireDays === "number"
              ? data.timeToHireDays.toFixed(1)
              : "—"}
          </strong>
          <span>
            {typeof data.timeToHireDays === "number"
              ? "average days"
              : "No complete observations yet"}
          </span>
        </div>
        <p className="muted small-text">
          Sample: {data.timeToHireSample ?? 0} application
          {data.timeToHireSample === 1 ? "" : "s"}. {data.hiresCount ?? 0} first
          Hired transition{data.hiresCount === 1 ? "" : "s"} in the selected
          activity period. Missing imported history remains unknown.
        </p>
        {data.stageDurations?.some((item) => item.count > 0) ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Observed stage</th>
                  <th>Average days</th>
                  <th>Completed transitions</th>
                </tr>
              </thead>
              <tbody>
                {data.stageDurations
                  .filter((item) => item.count > 0)
                  .map((item) => (
                    <tr key={item.stage}>
                      <td>{item.stage}</td>
                      <td>
                        {typeof item.averageDays === "number"
                          ? item.averageDays.toFixed(1)
                          : "Unknown"}
                      </td>
                      <td>{item.count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Stages reached in recorded history</h2>
            <p>Unique applications with an observed transition to each stage</p>
          </div>
        </div>
        {data.conversions?.some((item) => item.count > 0) ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Applications</th>
                  <th>Share of observed records</th>
                </tr>
              </thead>
              <tbody>
                {data.conversions.map((item) => (
                  <tr key={item.stage}>
                    <td>{item.stage}</td>
                    <td>{item.count}</td>
                    <td>
                      {typeof item.rate === "number"
                        ? `${(item.rate * 100).toFixed(1)}%`
                        : "Unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="chart-empty">
            Recorded stage transitions will appear here. Imported current stages
            do not supply a historical conversion path.
          </p>
        )}
      </section>
    </div>
  );
}
interface SeriesRow {
  date: string;
  applications: number;
  hired: number;
}
export function aggregateSeries(
  rows: SeriesRow[],
  period: "day" | "week" | "month",
) {
  const groups = new Map<string, SeriesRow>();
  for (const row of rows) {
    let date = row.date;
    if (period === "month") date = date.slice(0, 7);
    if (period === "week") {
      const d = new Date(`${date}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      date = d.toISOString().slice(0, 10);
    }
    const current = groups.get(date) || { date, applications: 0, hired: 0 };
    current.applications += row.applications;
    current.hired += row.hired;
    groups.set(date, current);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}
/** Day and week periods use the shared date format; months read "Nov 2026". */
export function seriesLabel(date: string, period: "day" | "week" | "month") {
  return period === "month"
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dubai",
        month: "short",
        year: "numeric",
      }).format(new Date(`${date}-01T12:00:00Z`))
    : formatDate(date);
}
export function SeriesChart({ rows }: { rows: SeriesRow[] }) {
  const [period, setPeriod] = useState<"day" | "week" | "month">("month");
  const data = aggregateSeries(rows, period);
  const max = Math.max(
    1,
    ...data.map((item) => Math.max(item.applications, item.hired)),
  );
  return (
    <div className="series-chart">
      <div className="row space-between">
        <div className="series-legend">
          <span>
            <i />
            Applications
          </span>
          <span>
            <i />
            Observed hires
          </span>
        </div>
        <div className="view-toggle">
          {(["day", "week", "month"] as const).map((p) => (
            <button
              key={p}
              aria-pressed={p === period}
              onClick={() => setPeriod(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {data.length ? (
        <>
          <div className="monthly-chart">
            {data.map((item) => (
              <div key={item.date} className="month-column">
                <div className="month-bars">
                  <span
                    style={{
                      height: `${Math.max((item.applications / max) * 100, item.applications ? 2 : 0)}%`,
                    }}
                    title={`${item.applications} applications`}
                  >
                    <b>{item.applications}</b>
                  </span>
                  <span
                    style={{
                      height: `${Math.max((item.hired / max) * 100, item.hired ? 2 : 0)}%`,
                    }}
                    title={`${item.hired} observed hires`}
                  >
                    <b>{item.hired}</b>
                  </span>
                </div>
                <small>{seriesLabel(item.date, period)}</small>
              </div>
            ))}
          </div>
          <details>
            <summary>View chart data as a table</summary>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>
                      Period{period === "week" ? " beginning Monday" : ""}
                    </th>
                    <th>Applications</th>
                    <th>Observed hires</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((item) => (
                    <tr key={item.date}>
                      <td>{seriesLabel(item.date, period)}</td>
                      <td>{item.applications}</td>
                      <td>{item.hired}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <p className="chart-empty">
          Recorded application and stage history will appear here.
        </p>
      )}
    </div>
  );
}
export function OfferStats() {
  const result = useApi<{
    offers: { name: string; count: number }[];
    declineReasons?: { name: string; count: number }[];
  }>(OFFER_STATS_PATH);
  return (
    <>
      {result.data && (
        <>
          <div className="mini-stat-grid">
            {["Sent", "Accepted", "Declined", "Draft"].map((status) => (
              <div className="mini-stat" key={status}>
                <span>{status} offers</span>
                <strong>
                  {result.data!.offers.find((item) => item.name === status)
                    ?.count ?? 0}
                </strong>
              </div>
            ))}
          </div>
          {result.data.declineReasons?.some(
            (item) => item.count > 0 && item.name !== "Not recorded",
          ) && (
            <details className="panel">
              <summary>Recorded decline reasons</summary>
              <BarChart data={result.data.declineReasons} />
            </details>
          )}
        </>
      )}
      {result.error && (
        <p className="notice error" role="alert">
          Offer statistics could not be loaded: {result.error}
        </p>
      )}
    </>
  );
}
