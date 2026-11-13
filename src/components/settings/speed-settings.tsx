"use client";

import { Gauge } from "lucide-react";
import { useApi } from "@/components/workspace/client";
import { formatNumber } from "@/components/workspace/helpers";
import {
  SettingsNavigation,
  useAdminPortalLink,
  useManagedGroupsLink,
} from "./settings-navigation";

export interface SpeedRow {
  kind: "action" | "route";
  name: string;
  samples: number;
  medianMs: number;
  p95Ms: number;
  medianDbMs?: number | null;
  p95DbMs?: number | null;
}
const ms = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "Not reported"
    : `${formatNumber(value)} ms`;

/**
 * /app/settings/speed for a caller who is not an owner or admin of the current team, since the
 * server sends owners and admins to the team detail Speed tab.
 */
export function SpeedSettings() {
  const adminPortal = useAdminPortalLink();
  const managedGroups = useManagedGroupsLink();
  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Speed</h1>
          <p className="muted">
            How long common actions and API requests take for this team.
          </p>
        </div>
        <Gauge size={28} aria-hidden="true" />
      </header>
      <SettingsNavigation
        adminPortal={adminPortal}
        managedGroups={managedGroups}
      />
      <p className="notice" role="status">
        Only team owners and admins can view speed timings.
      </p>
    </div>
  );
}

/** The team detail Speed tab: typical and slow times per action and API route, last 30 days. */
export function SpeedTab() {
  const result = useApi<{ data: SpeedRow[] }>("/api/v1/teams/speed");
  return <SpeedPanel rows={result.data?.data ?? null} error={result.error} />;
}

export function SpeedPanel({
  rows,
  error,
}: {
  rows: SpeedRow[] | null;
  error: string;
}) {
  const actions = rows?.filter((row) => row.kind === "action") ?? [];
  const routes = rows?.filter((row) => row.kind === "route") ?? [];
  return (
    <section className="panel stack">
      <h2>Speed</h2>
      <p className="muted">
        This panel holds the last 30 days of timings and route names only, with
        no names, ids or content. Typical is the median; slow is the 95th
        percentile.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          Could not load speed timings. {error}
        </p>
      ) : !rows ? (
        <p role="status">Loading speed timings…</p>
      ) : !rows.length ? (
        <p className="muted">No timings have been recorded yet.</p>
      ) : (
        <>
          {actions.length > 0 && (
            <SpeedTable title="Actions" rows={actions} database={false} />
          )}
          {routes.length > 0 && (
            <SpeedTable title="API routes" rows={routes} database />
          )}
        </>
      )}
    </section>
  );
}

function SpeedTable({
  title,
  rows,
  database,
}: {
  title: string;
  rows: SpeedRow[];
  database: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table speed-table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th>{database ? "Route" : "Action"}</th>
            <th>Typical</th>
            <th>Slow</th>
            {database && <th>Typical database</th>}
            {database && <th>Slow database</th>}
            <th>Samples</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.kind}:${row.name}`}>
              <td data-label={database ? "Route" : "Action"}>
                <code>{row.name}</code>
              </td>
              <td data-label="Typical">{ms(row.medianMs)}</td>
              <td data-label="Slow">{ms(row.p95Ms)}</td>
              {database && (
                <td data-label="Typical database">{ms(row.medianDbMs)}</td>
              )}
              {database && (
                <td data-label="Slow database">{ms(row.p95DbMs)}</td>
              )}
              <td data-label="Samples">{formatNumber(row.samples)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
