"use client";

import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Search } from "lucide-react";
import {
  RESOURCE_CONFIG,
  TASK_LINK_KINDS,
  createRecordSchemas,
  updateRecordSchemas,
  referencesByKind,
  kindToResource,
  recordDataSchemas,
  type RecordDto,
  type RecordKind,
  type ResourceName,
  type ReferenceField,
  type FieldConfig,
} from "@/domain/records";
import { Dialog } from "@/components/ui/dialog";
import { UnitPicker } from "@/components/settings/unit-picker";
import type { ActionResource } from "@/domain/config";
import type { AccessMap } from "@/lib/authz";
import {
  ClientError,
  useApi,
  useDebounced,
  useUnsavedWork,
  useWorkspace,
  requestJson,
  humanError,
  teamRequester,
} from "./client";
import { DuplicateWarning, useDuplicateLookup } from "./duplicate-warning";
import {
  dataOf,
  recordLabel,
  roleSnapshot,
  toDubaiInput,
  fromDubaiInput,
} from "./helpers";
import { assigneeInput, recordMutation, customValueDefaults } from "./mutation";
import { startSpeedTimer } from "./speed-log";
import { useTeamMembers, type TeamMember } from "./team-members";

type Values = Record<string, unknown>;
/** A vacancy's org unit as the editor shows it: its id and "Name (CODE)". */
type ChosenUnit = { id: string; label: string } | null;
/** Most assignees a task takes (recordDataSchemas.task). */
const ASSIGNEE_LIMIT = 10;
/** The linked record type of a task whose linked record the caller cannot see. */
const UNAVAILABLE = "unavailable";
const REFERENCE_LABELS: Record<ReferenceField, string> = {
  candidateId: "Candidate",
  vacancyId: "Vacancy",
  applicationId: "Application",
  onboardingId: "Onboarding",
  bucketId: "Workflow bucket",
  jobRoleId: "Job role",
  parentRecordId: "Parent record",
};
function defaults(kind: RecordKind): Values {
  const input: Values = {};
  for (const field of RESOURCE_CONFIG[kindToResource[kind]].fields) {
    if (field.required)
      input[field.key] =
        field.key === "startAt" ? new Date().toISOString() : "Draft";
  }
  const parsed = recordDataSchemas[kind].safeParse(input);
  const result: Values = parsed.success ? (parsed.data as Values) : {};
  for (const field of RESOURCE_CONFIG[kindToResource[kind]].fields) {
    if (field.required && field.key !== "startAt") result[field.key] = "";
    if (result[field.key] === undefined)
      result[field.key] =
        field.type === "tags"
          ? []
          : field.type === "checkbox"
            ? false
            : field.type === "number"
              ? null
              : field.type === "json"
                ? {}
                : field.options?.[0] || "";
  }
  return result;
}
interface RecordEditorProps {
  resource: ResourceName;
  record?: RecordDto;
  prefill?: Values;
  references?: Partial<Record<ReferenceField, string>>;
  onClose: () => void;
  onSaved: (record: RecordDto) => void;
}
export function RecordEditor({
  resource,
  record,
  prefill = {},
  references = {},
  onClose,
  onSaved,
}: RecordEditorProps) {
  const config = RESOURCE_CONFIG[resource];
  const { team } = useWorkspace();
  const [values, setValues] = useState<Values>(() => ({
    ...defaults(config.kind),
    ...(record ? dataOf(record) : {}),
    ...prefill,
  }));
  const [refs, setRefs] = useState<Partial<Record<ReferenceField, string>>>(
    () => {
      const result = { ...references };
      if (record)
        for (const key of Object.keys(
          referencesByKind[config.kind],
        ) as ReferenceField[])
          if (record[key]) result[key] = record[key]!;
      return result;
    },
  );
  // Vacancies only: the unit as saved, the one this save will send and the picker's fallback.
  const [savedUnit] = useState<ChosenUnit>(() =>
    record?.orgUnitId
      ? { id: record.orgUnitId, label: record.orgUnitLabel ?? "Org unit" }
      : null,
  );
  const [orgUnit, setOrgUnit] = useState<ChosenUnit>(savedUnit);
  const [unitBase, setUnitBase] = useState<ChosenUnit>(savedUnit);
  const [pickerKey, setPickerKey] = useState(0);
  const [unitError, setUnitError] = useState("");
  const unitChanged = (orgUnit?.id ?? null) !== (savedUnit?.id ?? null);
  const teamId = team?.id ?? null;
  const request = useMemo(
    () => (teamId ? teamRequester(teamId) : null),
    [teamId],
  );
  // Tasks only: the assignees as saved and as chosen, the team's members and the linked record's
  // type, preset from parentKind; a link the caller cannot see keeps its id until they pick None.
  const [savedAssignees] = useState<string[]>(() =>
    record && Array.isArray(dataOf(record).assigneeIds)
      ? (dataOf(record).assigneeIds as string[])
      : [],
  );
  const [assignees, setAssignees] = useState<string[]>(savedAssignees);
  const assigneesChanged =
    assigneeInput(savedAssignees, assignees).assigneeIds !== undefined;
  const members = useTeamMembers(teamId, resource === "tasks");
  const access = useApi<{ data: AccessMap }>(
    resource === "tasks" ? "/api/v1/me/access" : null,
  );
  // A role that hides assigneeIds leaves it out of the record, so the picker is left out too.
  const assigneesShown =
    resource === "tasks" &&
    (record
      ? Array.isArray(dataOf(record).assigneeIds)
      : access.data?.data.fields.task?.assigneeIds !== "hidden");
  const [linkKind, setLinkKind] = useState<string>(
    () => record?.parentKind ?? (record?.parentRecordId ? UNAVAILABLE : ""),
  );
  const linkKinds = TASK_LINK_KINDS.filter(
    (kind) =>
      kind === record?.parentKind ||
      access.data?.data.actions[
        kindToResource[kind] as ActionResource
      ]?.includes("view"),
  );
  const [opened] = useState(() => JSON.stringify([values, refs]));
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useUnsavedWork(
    saving ||
      unitChanged ||
      assigneesChanged ||
      JSON.stringify([values, refs]) !== opened,
  );
  const [copyingRole, setCopyingRole] = useState(false);
  const pending = saving || copyingRole;
  const [advanced, setAdvanced] = useState(false);
  const idempotency = useRef(new Map<string, string>());
  const errorRef = useRef<HTMLDivElement>(null);
  const fields = useApi<{ data: RecordDto<"task-field">[] }>(
    resource === "tasks"
      ? "/api/v1/task-fields?pageSize=100&sort=position"
      : null,
  );
  const duplicates = useDuplicateLookup(
    team?.id ?? null,
    resource === "candidates",
    values.email,
    values.phone,
  );
  const update = (key: string, value: unknown) =>
    setValues((old) => ({ ...old, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!team || pending) return;
    setError("");
    setFieldErrors({});
    setUnitError("");
    const submitted =
      resource === "tasks"
        ? {
            ...values,
            customValues: customValueDefaults(
              (values.customValues as Values) || {},
              fields.data?.data || [],
            ),
          }
        : values;
    const mutation = recordMutation(resource, submitted, refs, record);
    const input: Values = {
      ...mutation,
      // Sent only when they changed, so a save that leaves them alone never touches them.
      ...(resource === "vacancies" && unitChanged
        ? { orgUnitId: orgUnit?.id ?? null }
        : {}),
      ...(resource === "tasks"
        ? {
            data: {
              ...mutation.data,
              ...assigneeInput(savedAssignees, assignees),
            },
          }
        : {}),
    };
    const parsed = (
      record
        ? updateRecordSchemas[config.kind]
        : createRecordSchemas[config.kind]
    ).safeParse(input);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.filter((part) => part !== "data").join(".");
        errors[path || "form"] = issue.message;
      }
      setFieldErrors(errors);
      setError("Please review the highlighted fields.");
      setTimeout(() => errorRef.current?.focus(), 0);
      return;
    }
    setSaving(true);
    // Click to saved, for the two editor saves the speed log times.
    const timed =
      resource === "candidates"
        ? startSpeedTimer("candidate.save")
        : resource === "interviews" && !record
          ? startSpeedTimer("interview.schedule")
          : null;
    try {
      const serialized = JSON.stringify(input);
      let key = idempotency.current.get(serialized);
      if (!key) {
        key = crypto.randomUUID();
        idempotency.current.set(serialized, key);
      }
      const response = await requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/${resource}${record ? `/${record.id}` : ""}`,
        {
          method: record ? "PATCH" : "POST",
          headers: record ? {} : { "Idempotency-Key": key },
          body: serialized,
        },
      );
      timed?.();
      onSaved(response.data);
    } catch (e) {
      // The unit is refused only when it changed; the rest of the draft stays as entered.
      if (
        unitChanged &&
        e instanceof ClientError &&
        e.code === "invalid_reference" &&
        e.message.startsWith("orgUnitId")
      ) {
        setUnitError(
          "This unit is not a current unit of your company. Choose another unit, or remove the org unit.",
        );
        setError("Please review the org unit.");
      } else setError(humanError(e));
      setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setSaving(false);
    }
  };
  const applyRole = async (id: string) => {
    if (!id || !team || pending) return;
    setCopyingRole(true);
    try {
      const role = await requestJson<{ data: RecordDto<"job-role"> }>(
        team.id,
        `/api/v1/job-roles/${id}`,
      );
      setValues((old) => ({ ...old, ...roleSnapshot(role.data.data) }));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setCopyingRole(false);
    }
  };
  return (
    <Dialog
      title={`${record ? "Edit" : "Create"} ${config.singular.toLowerCase()}`}
      onClose={onClose}
      wide
      busy={pending}
    >
      <form onSubmit={submit}>
        <fieldset className="editor-fieldset" disabled={pending}>
          <div className="dialog-body stack">
            {error && (
              <div
                ref={errorRef}
                tabIndex={-1}
                className="notice error"
                role="alert"
              >
                <strong>{error}</strong>
                {Object.keys(fieldErrors).length > 0 && (
                  <ul>
                    {Object.entries(fieldErrors).map(([key, value]) => (
                      <li key={key}>
                        <a href={`#editor-${key}`}>
                          {key}: {value}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {resource === "candidates" && (
              <p className="notice">
                Record source facts only. Leave unknown information empty.
                Folder categories describe the source folders, rather than a
                hiring assessment.
              </p>
            )}
            <div className="form-grid">
              {Object.entries(referencesByKind[config.kind])
                // A task's linked record has its own type and record pickers below.
                .filter(
                  ([key]) =>
                    !(resource === "tasks" && key === "parentRecordId"),
                )
                .map(([key, details]) => (
                  <div key={key} className="field">
                    <ReferencePicker
                      kind={details.kind}
                      label={REFERENCE_LABELS[key as ReferenceField]}
                      value={refs[key as ReferenceField] || ""}
                      required={details.required}
                      disabled={!!record && details.immutable}
                      onChange={(value) =>
                        setRefs((old) => ({ ...old, [key]: value }))
                      }
                      id={`editor-${key}`}
                    />
                    {fieldErrors[key] && (
                      <span className="field-error">{fieldErrors[key]}</span>
                    )}
                    {key === "jobRoleId" && !record && refs.jobRoleId && (
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => applyRole(refs.jobRoleId!)}
                      >
                        Copy details from selected role
                      </button>
                    )}
                  </div>
                ))}
              {resource === "tasks" && (
                <div className="field">
                  <label htmlFor="editor-parent-kind">Linked record type</label>
                  <select
                    id="editor-parent-kind"
                    value={linkKind}
                    onChange={(e) => {
                      setLinkKind(e.target.value);
                      setRefs((old) => ({ ...old, parentRecordId: "" }));
                    }}
                  >
                    <option value="">None</option>
                    {linkKind === UNAVAILABLE && (
                      <option value={UNAVAILABLE}>Unavailable record</option>
                    )}
                    {linkKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {RESOURCE_CONFIG[kindToResource[kind]].singular}
                      </option>
                    ))}
                  </select>
                  {fieldErrors.parentRecordId && (
                    <span className="field-error">
                      {fieldErrors.parentRecordId}
                    </span>
                  )}
                </div>
              )}
              {resource === "tasks" && linkKind && linkKind !== UNAVAILABLE && (
                <div className="field">
                  <ReferencePicker
                    kind={linkKind as RecordKind}
                    label="Linked record"
                    value={refs.parentRecordId || ""}
                    onChange={(value) =>
                      setRefs((old) => ({ ...old, parentRecordId: value }))
                    }
                    id="editor-parentRecordId"
                  />
                </div>
              )}
              {config.fields
                .filter(
                  (field) =>
                    !field.readOnly &&
                    field.key !== "legacyAuthorLabel" &&
                    field.key !== "customValues" &&
                    field.key !== "assigneeIds" &&
                    (advanced ||
                      ![
                        "experienceWording",
                        "educationDates",
                        "latestRoleDates",
                        "roleStatus",
                        "educationStatus",
                        "experienceBasis",
                        "sourceNotes",
                      ].includes(field.key)),
                )
                .map((field) => (
                  <Fragment key={field.key}>
                    <FieldInput
                      field={field}
                      value={values[field.key]}
                      error={fieldErrors[field.key]}
                      onChange={(value) => update(field.key, value)}
                    />
                    {resource === "candidates" && field.key === "phone" && (
                      <DuplicateWarning
                        lookup={duplicates}
                        excludeId={record?.id}
                      />
                    )}
                  </Fragment>
                ))}
              {resource === "tasks" &&
                fields.data?.data.map((custom) => {
                  const field = custom.data;
                  const customValues = (values.customValues as Values) || {};
                  const type =
                    field.type === "Checkbox"
                      ? "checkbox"
                      : field.type === "Number"
                        ? "number"
                        : field.type === "Date"
                          ? "date"
                          : field.type === "Dropdown"
                            ? "select"
                            : "text";
                  return (
                    <FieldInput
                      key={custom.id}
                      field={{
                        key: custom.id,
                        label: field.name,
                        type,
                        required: field.required,
                        options: field.options,
                      }}
                      value={customValues[custom.id]}
                      error={fieldErrors[`customValues.${custom.id}`]}
                      onChange={(value) =>
                        update("customValues", {
                          ...customValues,
                          [custom.id]: value,
                        })
                      }
                    />
                  );
                })}
            </div>
            {assigneesShown && (
              <AssigneePicker
                members={members.members}
                error={members.error}
                selected={assignees}
                onChange={setAssignees}
                fieldError={fieldErrors.assigneeIds}
              />
            )}
            {resource === "vacancies" && request && (
              <fieldset
                className="stack"
                style={{
                  border: "1px solid var(--border, #e2e4eb)",
                  borderRadius: 10,
                  padding: 16,
                  minWidth: 0,
                }}
                aria-describedby={
                  unitError ? "editor-org-unit-error" : undefined
                }
              >
                <legend>Org unit</legend>
                <p id="editor-org-unit" style={{ margin: 0 }}>
                  {orgUnit ? orgUnit.label : "No org unit"}
                </p>
                {unitChanged && <small className="muted">Not saved yet.</small>}
                <UnitPicker
                  key={pickerKey}
                  request={request}
                  label="Choose an org unit"
                  emptyLabel="Choose a unit"
                  disabled={pending}
                  onChange={(unit) =>
                    setOrgUnit(
                      unit
                        ? { id: unit.id, label: `${unit.name} (${unit.code})` }
                        : unitBase,
                    )
                  }
                />
                {orgUnit && (
                  <div>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => {
                        setOrgUnit(null);
                        setUnitBase(null);
                        setUnitError("");
                        setPickerKey((key) => key + 1);
                      }}
                    >
                      Remove org unit
                    </button>
                  </div>
                )}
                {unitError && (
                  <span id="editor-org-unit-error" className="field-error">
                    {unitError}
                  </span>
                )}
              </fieldset>
            )}
            {resource === "tasks" && fields.error && (
              <p className="notice error" role="alert">
                Custom fields could not be loaded: {fields.error}. Refresh
                before creating a task.
              </p>
            )}
            {resource === "candidates" && (
              <button
                type="button"
                className="text-link"
                aria-expanded={advanced}
                onClick={() => setAdvanced((value) => !value)}
              >
                <ChevronDown size={16} aria-hidden="true" />
                {advanced ? "Hide" : "Show"} source and experience details
              </button>
            )}
            {resource === "interviews" && (
              <p className="muted">
                Interview times are entered in Dubai time (UTC+4), then stored
                in UTC.
              </p>
            )}
            {resource === "applications" && (
              <p className="muted">
                Application stages are manual. Offers, onboarding and task
                statuses are managed independently.
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="button"
              disabled={
                pending ||
                (resource === "tasks" && (fields.loading || !!fields.error))
              }
            >
              {saving ? (
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              ) : (
                <Check size={17} aria-hidden="true" />
              )}
              {copyingRole
                ? "Loading role…"
                : saving
                  ? "Saving…"
                  : record
                    ? "Save changes"
                    : `Create ${config.singular.toLowerCase()}`}
            </button>
          </footer>
        </fieldset>
      </form>
    </Dialog>
  );
}
/**
 * A task's assignees: one native checkbox per team member by name, with a filter. At most ten; an
 * assignee who is no longer a member shows as "Former member" and cannot be removed here, since the
 * service refuses to change a non-member's assignment. A load failure disables only this group.
 */
export function AssigneePicker({
  members,
  error,
  selected,
  onChange,
  fieldError,
}: {
  members: TeamMember[] | null;
  error: string;
  selected: string[];
  onChange: (selected: string[]) => void;
  fieldError?: string;
}) {
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const countId = useId();
  const known = new Set((members ?? []).map((member) => member.userId));
  const former = members ? selected.filter((userId) => !known.has(userId)) : [];
  const full = selected.length >= ASSIGNEE_LIMIT;
  const wanted = filter.trim().toLocaleLowerCase();
  const shown = (members ?? []).filter((member) =>
    member.name.toLocaleLowerCase().includes(wanted),
  );
  return (
    <fieldset
      className="assignee-picker"
      id="editor-assigneeIds"
      disabled={!members || !!error}
      aria-describedby={countId}
    >
      <legend>Assignees</legend>
      {error ? (
        <p className="field-error" role="alert">
          Team members could not be loaded, so assignees cannot be changed:{" "}
          {error}
        </p>
      ) : !members ? (
        <p className="muted" role="status">
          Loading team members…
        </p>
      ) : (
        <>
          <label htmlFor={filterId}>Filter members</label>
          <input
            id={filterId}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="assignee-list">
            {former.map((userId) => (
              <li key={userId}>
                <label className="checkbox-label">
                  <input type="checkbox" checked disabled />
                  Former member
                </label>
              </li>
            ))}
            {shown.map((member) => {
              const checked = selected.includes(member.userId);
              return (
                <li key={member.userId}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(e) =>
                        onChange(
                          e.target.checked
                            ? [...selected, member.userId]
                            : selected.filter((id) => id !== member.userId),
                        )
                      }
                    />
                    {member.name}
                  </label>
                </li>
              );
            })}
            {!shown.length && (
              <li className="muted">No member matches this filter.</li>
            )}
          </ul>
        </>
      )}
      <p id={countId} className="small-text muted" aria-live="polite">
        {selected.length} of {ASSIGNEE_LIMIT} selected
      </p>
      {fieldError && <span className="field-error">{fieldError}</span>}
    </fieldset>
  );
}
function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldConfig;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const [jsonText, setJsonText] = useState(() =>
    JSON.stringify(value ?? {}, null, 2),
  );
  const id = `editor-${field.key}`;
  const props = {
    id,
    name: field.key,
    required: field.required,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${id}-error` : undefined,
  };
  return (
    <div
      className={`field ${field.type === "textarea" || field.type === "json" ? "full-width" : ""}`}
    >
      <label htmlFor={id}>
        {field.label}
        {field.required && <span aria-label="required"> *</span>}
      </label>
      {field.type === "textarea" ? (
        <textarea
          {...props}
          rows={4}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.key === "body" ? 4000 : 10000}
        />
      ) : field.type === "json" ? (
        <textarea
          {...props}
          className="code-input"
          rows={5}
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value);
            }
          }}
        />
      ) : field.type === "select" ? (
        <select
          {...props}
          value={String(value ?? field.options?.[0] ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : field.type === "checkbox" ? (
        <label className="checkbox-label">
          <input
            {...props}
            type="checkbox"
            required={false}
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
          Enabled
        </label>
      ) : field.type === "tags" ? (
        <input
          {...props}
          value={Array.isArray(value) ? value.join(", ") : String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Separate values with commas"
        />
      ) : field.type === "datetime-local" ? (
        <input
          {...props}
          type="datetime-local"
          value={toDubaiInput(String(value || ""))}
          onChange={(e) => onChange(fromDubaiInput(e.target.value))}
        />
      ) : (
        <input
          {...props}
          type={
            field.type === "number"
              ? "number"
              : field.type === "date"
                ? "date"
                : field.key === "email"
                  ? "email"
                  : field.key === "color"
                    ? "color"
                    : "text"
          }
          value={String(value ?? "")}
          step={field.type === "number" ? "any" : undefined}
          min={
            field.type === "number" &&
            [
              "yearsExperience",
              "documentedYearsEstimate",
              "openings",
              "position",
              "minutes",
            ].includes(field.key)
              ? 0
              : undefined
          }
          onChange={(e) =>
            onChange(
              field.type === "number"
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
          }
          maxLength={field.type === "text" ? 2000 : undefined}
        />
      )}
      {field.type === "tags" && <small>Comma-separated values</small>}
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}
export function ReferencePicker({
  kind,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
  id,
}: {
  kind: RecordKind | "*";
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const generated = useId();
  const inputId = id || generated;
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const resource = kind === "*" ? "candidates" : kindToResource[kind];
  const result = useApi<{ data: RecordDto[] }>(
    disabled
      ? null
      : `/api/v1/${resource}?pageSize=100&search=${encodeURIComponent(debounced)}`,
  );
  const selected = useApi<{ data: RecordDto }>(
    value && !result.data?.data.some((item) => item.id === value)
      ? `/api/v1/${resource}/${value}`
      : null,
  );
  const options = result.data?.data || [];
  const selectedRecord = selected.data?.data;
  return (
    <>
      <label htmlFor={inputId}>
        {label}
        {required ? " *" : ""}
      </label>
      {!disabled && (
        <div className="reference-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label={`Search ${label.toLowerCase()} options`}
            placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <select
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        aria-invalid={!!result.error}
      >
        <option value="">{required ? "Select an option" : "None"}</option>
        {selectedRecord &&
          !options.some((item) => item.id === selectedRecord.id) && (
            <option value={selectedRecord.id}>
              {recordLabel(selectedRecord)}
            </option>
          )}
        {value &&
          !selectedRecord &&
          !options.some((item) => item.id === value) && (
            <option value={value}>
              {selected.loading
                ? "Loading selected record…"
                : `Selected record ${value.slice(0, 8)}`}
            </option>
          )}
        {options.map((item) => (
          <option key={item.id} value={item.id}>
            {recordLabel(item)}
            {item.kind === "application" ? ` · ${item.id.slice(0, 8)}` : ""}
          </option>
        ))}
      </select>
      {result.loading && <small role="status">Loading options…</small>}
      {result.error && (
        <small className="field-error" role="alert">
          {result.error}
        </small>
      )}
      {options.length === 100 && <small>Search to narrow these options.</small>}
    </>
  );
}
