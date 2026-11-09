"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { authClient } from "@/lib/auth-client";
import type { Action } from "@/domain/config";
import type { ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  ClientError,
  humanError,
  teamRequester,
  useWorkspace,
} from "@/components/workspace/client";
import type { Requester } from "@/components/workspace/optimistic";
import type { Employee, Position } from "@/lib/directory";
import type { OrgLevel, OrgUnit } from "@/lib/org";
import type { MeAccess } from "./admin-portal";
import {
  ERASED_NOTICE,
  EmployeeErasureDialog,
  RetentionReview,
  type ErasureTarget,
} from "./employee-erasure";
import {
  FormDialog,
  LEVELS_PATH,
  positionsPath,
  type Page,
} from "./organisation-tab";
import { UnitPicker } from "./unit-picker";

export interface DirectoryFilters {
  search: string;
  unitId: string;
  levelId: string;
  positionId: string;
  status: "" | Employee["status"];
  includeArchived: boolean;
}
export interface TeamMember {
  userId: string;
  name: string;
}
export interface DirectoryRowHandlers {
  edit: (row: Employee) => void;
  positions: (row: Employee) => void;
  link: (row: Employee) => void;
  unlink: (row: Employee) => void;
  archive: (row: Employee) => void;
  erase: (target: ErasureTarget) => void;
}
type EmployeeForm =
  | { kind: "add" }
  | { kind: "edit"; row: Employee }
  | { kind: "positions"; row: Employee }
  | { kind: "link"; row: Employee };

export const DIRECTORY_PAGE_SIZE = 25;
export const NO_FILTERS: DirectoryFilters = {
  search: "",
  unitId: "",
  levelId: "",
  positionId: "",
  status: "",
  includeArchived: false,
};
/** GET /api/v1/employees with only the filters that are set; unitId includes the units below. */
export function directoryPath(filters: DirectoryFilters, page: number) {
  const query = new URLSearchParams();
  const search = filters.search.trim();
  if (search) query.set("search", search);
  if (filters.unitId) query.set("unitId", filters.unitId);
  if (filters.levelId) query.set("levelId", filters.levelId);
  if (filters.positionId) query.set("positionId", filters.positionId);
  if (filters.status) query.set("status", filters.status);
  if (filters.includeArchived) query.set("includeArchived", "true");
  query.set("page", String(page));
  query.set("pageSize", String(DIRECTORY_PAGE_SIZE));
  return `/api/v1/employees?${query}`;
}
const statusLabels = { active: "Active", left: "Left" } as const;
const classLabels = { standard: "Standard", extended: "Extended" } as const;
const MAX_POSITIONS = 20;
/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);
// Row actions never break inside a word; a narrow table scrolls inside its .table-wrap.
const actionRow = { flexWrap: "wrap", overflowWrap: "normal", gap: 8 } as const;

/** The current team's members by name, from Better Auth, as the History tab names them. */
function useTeamMembers(teamId: string | null, enabled: boolean) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!teamId || !enabled) return;
    let active = true;
    authClient.organization
      .getFullOrganization({ query: { organizationId: teamId } })
      .then((result) => {
        if (result.error)
          throw new Error(
            result.error.message || "The team's members could not be loaded.",
          );
        const list = (result.data?.members ?? []) as {
          userId: string;
          user: { name: string };
        }[];
        if (active)
          setMembers(
            list.map((item) => ({ userId: item.userId, name: item.user.name })),
          );
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [teamId, enabled]);
  return { members, error };
}

/**
 * The Directory tab (R2a-16), for contexts holding directory:read: search and filter employees
 * with paging. Work email and phone show only when the service returns them (the full rule).
 * Employee writes follow the caller's directory actions; linking, unlinking and a linked
 * employee's positions are offered to company owners only, as are erasure and the retention review.
 */
export function DirectoryTab({ access }: { access: MeAccess }) {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const request = useMemo(
    () => (teamId ? teamRequester(teamId) : null),
    [teamId],
  );
  const owner = access.companyLevel === "owner";
  const actions = useMemo(
    () => access.actions.directory ?? [],
    [access.actions.directory],
  );
  const [draft, setDraft] = useState<DirectoryFilters>(NO_FILTERS);
  const [applied, setApplied] = useState<DirectoryFilters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [reloads, setReloads] = useState(0);
  const path = directoryPath(applied, page);
  const [result, setResult] = useState<{
    path: string;
    reloads: number;
    data: Page<Employee> | null;
    error: string;
  } | null>(null);
  const busy = !result || result.path !== path || result.reloads !== reloads;
  const [levels, setLevels] = useState<OrgLevel[] | null>(null);
  const [unitPositions, setUnitPositions] = useState<Position[] | null>(null);
  const [filterError, setFilterError] = useState("");
  const [form, setForm] = useState<EmployeeForm | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [erasing, setErasing] = useState<ErasureTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [focusNotice, setFocusNotice] = useState(0);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusStatus = useRef(false);
  const { confirm, dialog } = useConfirm();
  const { members, error: memberError } = useTeamMembers(
    teamId,
    owner && actions.includes("edit"),
  );

  useEffect(() => {
    if (!request) return;
    let active = true;
    request<Page<Employee>>(path)
      .then((data) => {
        if (active) setResult({ path, reloads, data, error: "" });
      })
      .catch((e) => {
        if (active)
          setResult({ path, reloads, data: null, error: humanError(e) });
      });
    return () => {
      active = false;
    };
  }, [request, path, reloads]);
  useEffect(() => {
    if (!request) return;
    let active = true;
    request<{ data: OrgLevel[] }>(LEVELS_PATH)
      .then((found) => {
        if (active) setLevels(found.data);
      })
      .catch((e) => {
        if (active) setFilterError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [request]);
  // After paging, focus moves to the page line, since the pressed button may be gone.
  useEffect(() => {
    if (!busy && focusStatus.current) {
      focusStatus.current = false;
      statusRef.current?.focus();
    }
  }, [busy]);
  // After the closed dialog has returned focus to its button, which the reload then removes.
  useEffect(() => {
    if (focusNotice) noticeRef.current?.focus();
  }, [focusNotice]);

  const reload = () => setReloads((count) => count + 1);
  const setRowError = (id: string, message: string) =>
    setRowErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  function chooseUnit(unit: OrgUnit | null) {
    setDraft((current) => ({
      ...current,
      unitId: unit?.id ?? "",
      positionId: "",
    }));
    setUnitPositions(null);
    if (!unit || !request) return;
    request<Page<Position>>(positionsPath(unit.id))
      .then((found) => setUnitPositions(found.data))
      .catch((e) => setFilterError(humanError(e)));
  }
  function search(event: FormEvent) {
    event.preventDefault();
    setApplied(draft);
    setPage(1);
  }
  function goTo(next: number) {
    focusStatus.current = true;
    setPage(next);
  }
  async function patchRow(
    row: Employee,
    body: unknown,
    question: ConfirmOptions,
  ) {
    if (!request || !(await confirm(question))) return;
    setRowError(row.id, "");
    try {
      await request(`/api/v1/employees/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      reload();
    } catch (e) {
      setRowError(row.id, plainError(e));
    }
  }
  const handlers: DirectoryRowHandlers = {
    edit: (row) => setForm({ kind: "edit", row }),
    positions: (row) => setForm({ kind: "positions", row }),
    link: (row) => setForm({ kind: "link", row }),
    unlink: (row) =>
      void patchRow(
        row,
        { userId: null },
        {
          title: `Unlink ${row.displayName} from their user account?`,
          message:
            "The employee stays in the directory without a user account. Once unit roles arrive, this changes which records the person can see.",
          confirmLabel: "Unlink user",
          destructive: true,
        },
      ),
    archive: (row) =>
      void patchRow(
        row,
        { archived: true },
        {
          title: `Archive ${row.displayName}?`,
          message:
            "The employee leaves the directory lists and their positions end. Archived employees can still be found with Include archived employees.",
          confirmLabel: "Archive",
          destructive: true,
        },
      ),
    erase: (target) => {
      setNotice("");
      setErasing(target);
    },
  };
  /** Sends one employee write; a refusal throws, so the dialog shows it. */
  async function write(path: string, method: string, body: unknown) {
    if (!request) return;
    await request(path, { method, body: JSON.stringify(body) });
    setForm(null);
    reload();
  }

  return (
    <>
      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          className="notice success"
          role="status"
        >
          {notice}
        </p>
      )}
      <section className="panel stack">
        <h2>Directory</h2>
        <p className="muted">
          Find employees by name or employee number, and filter by unit
          (including the units below it), level, position and status.
        </p>
        <DirectoryFilterForm
          filters={draft}
          levels={levels}
          positions={unitPositions}
          request={request}
          error={filterError}
          onChange={(change) =>
            setDraft((current) => ({ ...current, ...change }))
          }
          onUnit={chooseUnit}
          onSubmit={search}
        />
        {actions.includes("create") && (
          <div className="row">
            <button
              type="button"
              className="button secondary"
              onClick={() => setForm({ kind: "add" })}
            >
              Add employee
            </button>
          </div>
        )}
        {result?.error ? (
          <p className="notice error" role="alert">
            Could not load the directory. {result.error}
          </p>
        ) : !result?.data ? (
          <p role="status">Loading employees…</p>
        ) : (
          <>
            <DirectoryTable
              rows={result.data.data}
              owner={owner}
              actions={actions}
              errors={rowErrors}
              on={handlers}
            />
            <DirectoryPaging
              page={result.data.pagination.page}
              hasMore={result.data.pagination.hasMore}
              busy={busy}
              statusRef={statusRef}
              onPage={goTo}
            />
          </>
        )}
      </section>
      {owner && teamId && (
        <RetentionReview
          teamId={teamId}
          reloads={reloads}
          onErase={handlers.erase}
        />
      )}
      {form && request && (
        <EmployeeDialog
          form={form}
          request={request}
          members={members}
          memberError={memberError}
          confirm={confirm}
          onWrite={write}
          onClose={() => setForm(null)}
        />
      )}
      {erasing && teamId && (
        <EmployeeErasureDialog
          key={erasing.id}
          teamId={teamId}
          target={erasing}
          onCancel={() => setErasing(null)}
          onErased={() => {
            setErasing(null);
            setNotice(ERASED_NOTICE);
            setFocusNotice((count) => count + 1);
            reload();
          }}
        />
      )}
      {dialog}
    </>
  );
}

export function DirectoryFilterForm({
  filters,
  levels,
  positions,
  request,
  error,
  onChange = () => {},
  onUnit = () => {},
  onSubmit = (event) => event.preventDefault(),
}: {
  filters: DirectoryFilters;
  levels: OrgLevel[] | null;
  /** The positions of the chosen unit; null before a unit is chosen. */
  positions: Position[] | null;
  request: Requester | null;
  error: string;
  onChange?: (change: Partial<DirectoryFilters>) => void;
  onUnit?: (unit: OrgUnit | null) => void;
  onSubmit?: (event: FormEvent) => void;
}) {
  return (
    <form
      className="stack"
      style={{ gap: 12 }}
      aria-label="Directory filters"
      onSubmit={onSubmit}
    >
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="field">
          <span>Name or employee number</span>
          <input
            value={filters.search}
            maxLength={120}
            autoComplete="off"
            onChange={(event) => onChange({ search: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Level</span>
          <select
            value={filters.levelId}
            onChange={(event) => onChange({ levelId: event.target.value })}
          >
            <option value="">Any level</option>
            {(levels ?? []).map((level) => (
              <option key={level.id} value={level.id}>
                {level.name}
                {level.archivedAt ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={filters.status}
            onChange={(event) =>
              onChange({
                status: event.target.value as DirectoryFilters["status"],
              })
            }
          >
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="left">Left</option>
          </select>
        </label>
      </div>
      {request && (
        <UnitPicker
          request={request}
          label="Unit"
          emptyLabel="Any unit"
          onChange={onUnit}
        />
      )}
      <label className="field">
        <span>Position</span>
        <select
          value={filters.positionId}
          disabled={!filters.unitId || !positions}
          onChange={(event) => onChange({ positionId: event.target.value })}
        >
          <option value="">
            {filters.unitId ? "Any position" : "Choose a unit first"}
          </option>
          {(filters.unitId ? (positions ?? []) : []).map((position) => (
            <option key={position.id} value={position.id}>
              {position.title} ({position.code})
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={filters.includeArchived}
          onChange={(event) =>
            onChange({ includeArchived: event.target.checked })
          }
        />
        Include archived employees
      </label>
      {error && (
        <p className="notice error" role="alert">
          Could not load the filter choices. {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="button">
          Search
        </button>
      </div>
    </form>
  );
}

/**
 * One page of employees. Work email and phone columns exist only when the rows carry those keys,
 * so under the basic rule there is no contact header, cell or value.
 */
export function DirectoryTable({
  rows,
  owner,
  actions,
  errors = {},
  on = {},
}: {
  rows: Employee[];
  owner: boolean;
  actions: readonly Action[];
  errors?: Record<string, string>;
  on?: Partial<DirectoryRowHandlers>;
}) {
  if (!rows.length) return <p role="status">No employees match.</p>;
  const email = rows.some((row) => Object.hasOwn(row, "workEmail"));
  const phone = rows.some((row) => Object.hasOwn(row, "workPhone"));
  const edit = actions.includes("edit");
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">Employees</caption>
        <thead>
          <tr>
            <th>Name</th>
            <th>Employee number</th>
            <th>Positions</th>
            <th>Status</th>
            <th>Retention class</th>
            <th>User account</th>
            <th>Archived</th>
            {email && <th>Work email</th>}
            {phone && <th>Work phone</th>}
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = !row.archivedAt;
            const linked = row.userId !== null;
            return (
              <tr key={row.id}>
                <td data-label="Name">{row.displayName}</td>
                <td data-label="Employee number">{row.employeeNumber}</td>
                <td data-label="Positions">
                  {row.positions.length
                    ? row.positions.map((item) => item.title).join(", ")
                    : "None"}
                </td>
                <td data-label="Status">{statusLabels[row.status]}</td>
                <td data-label="Retention class">
                  {classLabels[row.retentionClass ?? "standard"]}
                </td>
                <td data-label="User account">
                  {linked ? "Linked" : "Not linked"}
                </td>
                <td data-label="Archived">{row.archivedAt ? "Yes" : "No"}</td>
                {email && (
                  <td data-label="Work email">
                    {row.workEmail || "Not recorded"}
                  </td>
                )}
                {phone && (
                  <td data-label="Work phone">
                    {row.workPhone || "Not recorded"}
                  </td>
                )}
                <td data-label="Actions">
                  <div className="row" style={actionRow}>
                    {current && edit && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => on.edit?.(row)}
                      >
                        Edit<span className="sr-only">: {row.displayName}</span>
                      </button>
                    )}
                    {current && edit && (!linked || owner) && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => on.positions?.(row)}
                      >
                        Positions
                        <span className="sr-only">: {row.displayName}</span>
                      </button>
                    )}
                    {current && edit && owner && !linked && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => on.link?.(row)}
                      >
                        Link to user
                        <span className="sr-only">: {row.displayName}</span>
                      </button>
                    )}
                    {current && edit && owner && linked && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => on.unlink?.(row)}
                      >
                        Unlink user
                        <span className="sr-only">: {row.displayName}</span>
                      </button>
                    )}
                    {current && actions.includes("archive") && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => on.archive?.(row)}
                      >
                        Archive
                        <span className="sr-only">: {row.displayName}</span>
                      </button>
                    )}
                    {owner && (
                      <button
                        type="button"
                        className="button danger small"
                        onClick={() =>
                          on.erase?.({ id: row.id, name: row.displayName })
                        }
                      >
                        Permanently erase employee
                        <span className="sr-only">: {row.displayName}</span>
                      </button>
                    )}
                  </div>
                  {errors[row.id] && (
                    <p className="notice error" role="alert">
                      {errors[row.id]}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Previous and Next from the service's page and hasMore; there is no total, so no page count. */
export function DirectoryPaging({
  page,
  hasMore,
  busy,
  statusRef,
  onPage = () => {},
}: {
  page: number;
  hasMore: boolean;
  busy: boolean;
  statusRef?: RefObject<HTMLParagraphElement | null>;
  onPage?: (page: number) => void;
}) {
  return (
    <div className="row space-between">
      <p ref={statusRef} tabIndex={-1} role="status" style={{ margin: 0 }}>
        {busy ? "Loading employees…" : `Page ${page}`}
      </p>
      <div className="row" style={actionRow}>
        {page > 1 && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onPage(page - 1)}
          >
            Previous page
          </button>
        )}
        {hasMore && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onPage(page + 1)}
          >
            Next page
          </button>
        )}
      </div>
    </div>
  );
}

function EmployeeDialog({
  form,
  request,
  members,
  memberError,
  confirm,
  onWrite,
  onClose,
}: {
  form: EmployeeForm;
  request: Requester;
  members: TeamMember[] | null;
  memberError: string;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  onWrite: (path: string, method: string, body: unknown) => Promise<void>;
  onClose: () => void;
}) {
  return form.kind === "positions" ? (
    <PositionsDialog
      row={form.row}
      request={request}
      onWrite={onWrite}
      onClose={onClose}
    />
  ) : form.kind === "link" ? (
    <LinkDialog
      row={form.row}
      members={members}
      memberError={memberError}
      confirm={confirm}
      onWrite={onWrite}
      onClose={onClose}
    />
  ) : (
    <FactsDialog
      row={form.kind === "edit" ? form.row : null}
      onWrite={onWrite}
      onClose={onClose}
    />
  );
}

/** A write in a dialog; any refusal shows in the dialog with the API's own message. */
function useDialogWrite(onWrite: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onWrite();
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

/**
 * Add employee, or Edit: the work email and phone inputs appear for a new employee, and on an edit
 * only when the row carries them (the full rule); otherwise they are never sent.
 */
function FactsDialog({
  row,
  onWrite,
  onClose,
}: {
  row: Employee | null;
  onWrite: (path: string, method: string, body: unknown) => Promise<void>;
  onClose: () => void;
}) {
  const [facts, setFacts] = useState({
    displayName: row?.displayName ?? "",
    employeeNumber: row?.employeeNumber ?? "",
    workEmail: row?.workEmail ?? "",
    workPhone: row?.workPhone ?? "",
    status: row?.status ?? ("active" as Employee["status"]),
    retentionClass: row?.retentionClass ?? ("standard" as const),
  });
  const email = !row || Object.hasOwn(row, "workEmail");
  const phone = !row || Object.hasOwn(row, "workPhone");
  const { busy, error, run } = useDialogWrite(() => {
    const body = {
      displayName: facts.displayName.trim(),
      employeeNumber: facts.employeeNumber.trim(),
      status: facts.status,
      retentionClass: facts.retentionClass,
      ...(email && (row || facts.workEmail.trim())
        ? { workEmail: facts.workEmail.trim() || null }
        : {}),
      ...(phone && (row || facts.workPhone.trim())
        ? { workPhone: facts.workPhone.trim() || null }
        : {}),
    };
    return row
      ? onWrite(`/api/v1/employees/${row.id}`, "PATCH", body)
      : onWrite("/api/v1/employees", "POST", body);
  });
  const set = (change: Partial<typeof facts>) =>
    setFacts((current) => ({ ...current, ...change }));
  return (
    <FormDialog
      title={row ? `Edit ${row.displayName}` : "Add employee"}
      submitLabel={row ? "Save employee" : "Add employee"}
      busy={busy}
      error={error}
      onSubmit={run}
      onClose={onClose}
    >
      <label className="field">
        <span>Display name</span>
        <input
          required
          maxLength={120}
          value={facts.displayName}
          disabled={busy}
          onChange={(event) => set({ displayName: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Employee number</span>
        <input
          required
          maxLength={120}
          value={facts.employeeNumber}
          disabled={busy}
          onChange={(event) => set({ employeeNumber: event.target.value })}
        />
      </label>
      {email && (
        <label className="field">
          <span>Work email</span>
          <input
            type="email"
            maxLength={320}
            value={facts.workEmail}
            disabled={busy}
            onChange={(event) => set({ workEmail: event.target.value })}
          />
        </label>
      )}
      {phone && (
        <label className="field">
          <span>Work phone</span>
          <input
            type="tel"
            maxLength={100}
            value={facts.workPhone}
            disabled={busy}
            onChange={(event) => set({ workPhone: event.target.value })}
          />
        </label>
      )}
      <label className="field">
        <span>Status</span>
        <select
          value={facts.status}
          disabled={busy}
          onChange={(event) =>
            set({ status: event.target.value as Employee["status"] })
          }
        >
          <option value="active">Active</option>
          <option value="left">Left</option>
        </select>
      </label>
      <label className="field">
        <span>Retention class</span>
        <select
          value={facts.retentionClass}
          disabled={busy}
          onChange={(event) =>
            set({
              retentionClass: event.target.value as typeof facts.retentionClass,
            })
          }
        >
          <option value="standard">Standard</option>
          <option value="extended">Extended</option>
        </select>
      </label>
    </FormDialog>
  );
}

interface Held {
  positionId: string;
  title: string;
  primary: boolean;
}

/** The employee's current positions, replaced as a whole by Save positions. */
function PositionsDialog({
  row,
  request,
  onWrite,
  onClose,
}: {
  row: Employee;
  request: Requester;
  onWrite: (path: string, method: string, body: unknown) => Promise<void>;
  onClose: () => void;
}) {
  const [held, setHeld] = useState<Held[]>(() =>
    row.positions.map(({ positionId, title, primary }) => ({
      positionId,
      title,
      primary,
    })),
  );
  const [unit, setUnit] = useState<OrgUnit | null>(null);
  const [choices, setChoices] = useState<Position[] | null>(null);
  const [choice, setChoice] = useState("");
  const [loadError, setLoadError] = useState("");
  const { busy, error, setError, run } = useDialogWrite(() =>
    onWrite(`/api/v1/employees/${row.id}/positions`, "PUT", {
      positions: held.map(({ positionId, primary }) => ({
        positionId,
        primary,
      })),
    }),
  );
  function chooseUnit(next: OrgUnit | null) {
    setUnit(next);
    setChoices(null);
    setChoice("");
    setLoadError("");
    if (!next) return;
    request<Page<Position>>(positionsPath(next.id))
      .then((found) => setChoices(found.data))
      .catch((e) => setLoadError(humanError(e)));
  }
  function add() {
    const position = choices?.find((item) => item.id === choice);
    if (!position) {
      setError("Choose a unit and a position to add.");
      return;
    }
    setError("");
    setHeld((current) =>
      current.some((item) => item.positionId === position.id)
        ? current
        : [
            ...current,
            {
              positionId: position.id,
              title: position.title,
              primary: !current.some((item) => item.primary),
            },
          ],
    );
    setChoice("");
  }
  const name = useId();
  return (
    <FormDialog
      title={`Positions of ${row.displayName}`}
      submitLabel="Save positions"
      busy={busy}
      error={error}
      wide
      onSubmit={run}
      onClose={onClose}
    >
      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0 }}>
        <legend>Current positions</legend>
        {held.length ? (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {held.map((item) => (
              <li key={item.positionId} className="row" style={actionRow}>
                <strong>{item.title}</strong>
                <label className="checkbox-label">
                  <input
                    type="radio"
                    name={name}
                    checked={item.primary}
                    disabled={busy}
                    onChange={() =>
                      setHeld((current) =>
                        current.map((entry) => ({
                          ...entry,
                          primary: entry.positionId === item.positionId,
                        })),
                      )
                    }
                  />
                  Primary position
                  <span className="sr-only">: {item.title}</span>
                </label>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    setHeld((current) =>
                      current.filter(
                        (entry) => entry.positionId !== item.positionId,
                      ),
                    )
                  }
                >
                  Remove<span className="sr-only">: {item.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No current positions.</p>
        )}
      </fieldset>
      <fieldset className="stack" style={{ gap: 12, border: 0, padding: 0 }}>
        <legend>Add a position</legend>
        <UnitPicker
          request={request}
          label="Unit"
          emptyLabel="Choose a unit"
          disabled={busy}
          onChange={chooseUnit}
        />
        <label className="field">
          <span>Position</span>
          <select
            value={choice}
            disabled={busy || !unit || !choices}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">
              {unit ? "Choose a position" : "Choose a unit first"}
            </option>
            {(choices ?? []).map((position) => (
              <option key={position.id} value={position.id}>
                {position.title} ({position.code})
              </option>
            ))}
          </select>
        </label>
        {loadError && (
          <p className="notice error" role="alert">
            Could not load the positions. {loadError}
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="button secondary"
            disabled={busy || held.length >= MAX_POSITIONS}
            onClick={add}
          >
            Add to positions
          </button>
        </div>
      </fieldset>
    </FormDialog>
  );
}

/** Company owners only: the current team's members, and a plain confirmation before sending. */
function LinkDialog({
  row,
  members,
  memberError,
  confirm,
  onWrite,
  onClose,
}: {
  row: Employee;
  members: TeamMember[] | null;
  memberError: string;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  onWrite: (path: string, method: string, body: unknown) => Promise<void>;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState("");
  const { busy, error, setError, run } = useDialogWrite(() =>
    onWrite(`/api/v1/employees/${row.id}`, "PATCH", { userId }),
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    const member = members?.find((item) => item.userId === userId);
    if (!member) {
      setError("Choose the team member to link.");
      return;
    }
    if (
      await confirm({
        title: `Link ${row.displayName} to ${member.name}?`,
        message: `Linking changes which records ${member.name} can see once unit roles arrive: their home units become the units of this employee's positions.`,
        confirmLabel: "Link to user",
      })
    )
      await run();
  }
  return (
    <FormDialog
      title={`Link ${row.displayName} to a user`}
      submitLabel="Link to user"
      busy={busy}
      error={error || memberError}
      onSubmit={(event) => void submit(event)}
      onClose={onClose}
    >
      <p className="muted">
        Only members of this team are listed. A user can be linked to one
        employee.
      </p>
      <label className="field">
        <span>Team member</span>
        <select
          value={userId}
          disabled={busy || !members}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="">
            {members ? "Choose a team member" : "Loading team members…"}
          </option>
          {(members ?? []).map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
    </FormDialog>
  );
}
