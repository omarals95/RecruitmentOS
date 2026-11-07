"use client";

import { useState, type FormEvent } from "react";
import { HardDrive } from "lucide-react";
import {
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";

export type StorageSettingsData = {
  maxBytes: number | null;
  maxFiles: number | null;
  uploadRequestsPerMinute: number | null;
  usage: {
    usedBytes: number;
    usedFiles: number;
    reservedBytes: number;
    reservedFiles: number;
    retainedBytes: number;
    retainedFiles: number;
  };
};
type StorageUnit = "MB" | "GB";
const UNIT_BYTES: Record<StorageUnit, number> = {
  MB: 1_000_000,
  GB: 1_000_000_000,
};
const MIN_BYTES = 1_000_000;
const MAX_BYTES = 10_000_000_000_000;
const MAX_FILES = 1_000_000;
const MAX_RATE = 600;

/**
 * Decimal bytes for an amount in MB or GB (1 MB = 1,000,000 bytes) with at most 3 decimal places,
 * so the result is always a whole number of bytes. Throws a plain message for anything else.
 */
export function parseStorageAmount(value: string, unit: StorageUnit): number {
  const match = /^(\d{1,14})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match)
    throw new Error(
      "Enter the maximum storage as a positive number with at most 3 decimal places.",
    );
  const bytes =
    Number(match[1]) * UNIT_BYTES[unit] +
    Number((match[2] ?? "").padEnd(3, "0")) * (UNIT_BYTES[unit] / 1000);
  if (bytes < MIN_BYTES || bytes > MAX_BYTES)
    throw new Error("Maximum storage must be between 1 MB and 10,000 GB.");
  return bytes;
}

/** Decimal units: MB below 1 GB, GB from there, up to 3 decimal places. */
export function formatStorageBytes(bytes: number): string {
  const unit: StorageUnit = bytes >= UNIT_BYTES.GB ? "GB" : "MB";
  return `${(bytes / UNIT_BYTES[unit]).toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit}`;
}

function wholeNumber(value: string, label: string, max: number): number {
  if (
    !/^\d{1,7}$/.test(value.trim()) ||
    Number(value) < 1 ||
    Number(value) > max
  )
    throw new Error(
      `${label} must be a whole number from 1 to ${max.toLocaleString("en-US")}.`,
    );
  return Number(value);
}
const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** A saved amount in the unit it reads best in; GB from 0.1 GB when it fits 3 decimals. */
function savedAmount(bytes: number): { amount: string; unit: StorageUnit } {
  const unit: StorageUnit =
    bytes >= 100_000_000 && bytes % 1_000_000 === 0 ? "GB" : "MB";
  return { amount: String(bytes / UNIT_BYTES[unit]), unit };
}

/** The form for loaded settings; remount it with new settings after a save. */
export function StorageSettingsForm({
  settings,
  busy,
  saving = false,
  onSave,
}: {
  settings: StorageSettingsData;
  /** Any page action is running; saving is this form's own save. */
  busy: boolean;
  saving?: boolean;
  onSave: (input: {
    maxBytes: number | null;
    maxFiles: number | null;
    uploadRequestsPerMinute: number | null;
  }) => void;
}) {
  const saved =
    settings.maxBytes === null ? undefined : savedAmount(settings.maxBytes);
  const [limited, setLimited] = useState(settings.maxBytes !== null);
  const [amount, setAmount] = useState(saved?.amount ?? "");
  const [unit, setUnit] = useState<StorageUnit>(saved?.unit ?? "GB");
  const [maxFiles, setMaxFiles] = useState(
    settings.maxFiles === null ? "" : String(settings.maxFiles),
  );
  const [rated, setRated] = useState(settings.uploadRequestsPerMinute !== null);
  const [rate, setRate] = useState(
    settings.uploadRequestsPerMinute === null
      ? ""
      : String(settings.uploadRequestsPerMinute),
  );
  const { usage } = settings;
  let input: Parameters<typeof onSave>[0] | undefined;
  let problem = "";
  try {
    input = {
      maxBytes: limited ? parseStorageAmount(amount, unit) : null,
      maxFiles: limited
        ? wholeNumber(maxFiles, "Maximum CV files", MAX_FILES)
        : null,
      uploadRequestsPerMinute: rated
        ? wholeNumber(rate, "Requests per minute", MAX_RATE)
        : null,
    };
  } catch (error) {
    problem = (error as Error).message;
  }
  const unchanged =
    !!input &&
    input.maxBytes === settings.maxBytes &&
    input.maxFiles === settings.maxFiles &&
    input.uploadRequestsPerMinute === settings.uploadRequestsPerMinute;
  const below =
    !!input &&
    input.maxBytes !== null &&
    input.maxFiles !== null &&
    (input.maxBytes <
      usage.usedBytes + usage.reservedBytes + usage.retainedBytes ||
      input.maxFiles <
        usage.usedFiles + usage.reservedFiles + usage.retainedFiles);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (input && !unchanged && !busy) onSave(input);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h3>Current usage</h3>
      <dl className="detail-facts">
        <div>
          <dt>Stored CVs</dt>
          <dd>{`${files(usage.usedFiles)}, ${formatStorageBytes(usage.usedBytes)}`}</dd>
        </div>
        <div>
          <dt>Uploads in progress</dt>
          <dd>{`${files(usage.reservedFiles)}, ${formatStorageBytes(usage.reservedBytes)}`}</dd>
        </div>
        <div>
          <dt>Files waiting for cleanup</dt>
          <dd>{`${files(usage.retainedFiles)}, ${formatStorageBytes(usage.retainedBytes)}`}</dd>
        </div>
      </dl>
      <label>
        <input
          type="checkbox"
          checked={limited}
          disabled={busy}
          onChange={(event) => setLimited(event.target.checked)}
        />{" "}
        Limit this team&apos;s CV storage
      </label>
      {limited && (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="storage-max-amount">Maximum storage</label>
            <div className="row">
              <input
                id="storage-max-amount"
                inputMode="decimal"
                value={amount}
                disabled={busy}
                onChange={(event) => setAmount(event.target.value)}
              />
              <select
                aria-label="Storage unit"
                value={unit}
                disabled={busy}
                onChange={(event) => setUnit(event.target.value as StorageUnit)}
              >
                <option value="MB">MB</option>
                <option value="GB">GB</option>
              </select>
            </div>
            <small className="muted">1 GB is 1,000 MB.</small>
          </div>
          <label className="field">
            <span>Maximum CV files</span>
            <input
              inputMode="numeric"
              value={maxFiles}
              disabled={busy}
              onChange={(event) => setMaxFiles(event.target.value)}
            />
          </label>
        </div>
      )}
      <label>
        <input
          type="checkbox"
          checked={rated}
          disabled={busy}
          onChange={(event) => setRated(event.target.checked)}
        />{" "}
        Limit CV upload requests
      </label>
      {rated && (
        <label className="field">
          <span>Requests per minute</span>
          <input
            inputMode="numeric"
            value={rate}
            disabled={busy}
            onChange={(event) => setRate(event.target.value)}
          />
        </label>
      )}
      {problem && (
        <p className="notice error" role="alert">
          {problem}
        </p>
      )}
      {below && (
        <p className="notice" role="status">
          This limit is below the team&apos;s current usage. Existing CVs stay
          available, but new CV uploads will be refused until usage is below the
          limit.
        </p>
      )}
      <div>
        <button
          type="submit"
          className="button"
          disabled={busy || !input || unchanged}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Owner and admin only: the team's CV storage limit, upload rate limit and current usage. */
export function StorageSettings({
  busy,
  onAction,
}: {
  busy: string;
  onAction: (
    key: string,
    work: () => Promise<void>,
    message: string,
  ) => Promise<void>;
}) {
  const { team } = useWorkspace();
  const path = "/api/v1/teams/storage-settings";
  const current = useApi<{ data: StorageSettingsData }>(team ? path : null);
  const settings = current.data?.data;
  return (
    <section className="panel">
      <h2>
        <HardDrive
          size={20}
          aria-hidden="true"
          style={{ verticalAlign: "middle" }}
        />{" "}
        CV storage
      </h2>
      <p className="muted">
        These are application limits, not hard provider caps. The store-wide
        budget set by the RecruitmentOS owner still applies.
      </p>
      {current.error ? (
        <p className="notice error" role="alert">
          Could not load CV storage settings. {current.error}
        </p>
      ) : !settings || !team ? (
        <p role="status">Loading CV storage settings…</p>
      ) : (
        <StorageSettingsForm
          key={JSON.stringify(settings)}
          settings={settings}
          busy={!!busy}
          saving={busy === "storage"}
          onSave={(input) =>
            void onAction(
              "storage",
              async () => {
                current.setData(
                  await requestJson<{ data: StorageSettingsData }>(
                    team.id,
                    path,
                    { method: "PUT", body: JSON.stringify(input) },
                  ),
                );
              },
              "CV storage settings saved.",
            )
          }
        />
      )}
    </section>
  );
}
