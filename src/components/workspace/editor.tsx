"use client";

import { useId, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Search } from "lucide-react";
import {
  RESOURCE_CONFIG,
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
import {
  useApi,
  useDebounced,
  useWorkspace,
  requestJson,
  humanError,
} from "./client";
import { dataOf, recordLabel, toDubaiInput, fromDubaiInput } from "./helpers";
import { recordMutation, customValueDefaults } from "./mutation";

type Values = Record<string, unknown>;
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
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
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
  const update = (key: string, value: unknown) =>
    setValues((old) => ({ ...old, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!team || pending) return;
    setError("");
    setFieldErrors({});
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
    const input = recordMutation(resource, submitted, refs, record);
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
      onSaved(response.data);
    } catch (e) {
      setError(humanError(e));
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
      setValues((old) => ({ ...old, ...role.data.data }));
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
              {Object.entries(referencesByKind[config.kind]).map(
                ([key, details]) => (
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
                ),
              )}
              {config.fields
                .filter(
                  (field) =>
                    !field.readOnly &&
                    field.key !== "legacyAuthorLabel" &&
                    field.key !== "customValues" &&
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
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    error={fieldErrors[field.key]}
                    onChange={(value) => update(field.key, value)}
                  />
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
