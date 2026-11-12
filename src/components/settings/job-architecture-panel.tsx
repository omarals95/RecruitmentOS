"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import {
  configKey,
  gradeCode,
  type JobArchitectureBody,
} from "@/domain/config";
import type {
  JobArchitecture,
  JobArchitectureDraft,
  JobTitleUsage,
} from "@/lib/job-architecture";
import type {
  SalaryBracket,
  SalaryBracketInput,
  SalaryBracketVersion,
} from "@/lib/pay-brackets";
import { tabKeys } from "@/components/ui/tab-keys";
import { ClientError, humanError } from "@/components/workspace/client";
import { formatDate, formatNumber } from "@/components/workspace/helpers";
import type { Requester } from "@/components/workspace/optimistic";
import type { MeAccess } from "./admin-portal";
import { slugFor } from "./create-team";
import { REAUTH_CANCELLED, useFreshSession } from "./fresh-session-dialog";
import { FormDialog } from "./organisation-tab";
import { box, useFocusAfter } from "./roles-tab";

type Family = JobArchitectureBody["families"][number];
type Grade = JobArchitectureBody["grades"][number];
type Title = JobArchitectureBody["titles"][number];
type PayPeriod = SalaryBracketVersion["payPeriod"];
type BracketCover = SalaryBracketVersion["covers"];
export interface JobArchitectureState {
  current: JobArchitecture | null;
  /** Only company owners and company admins with organisation get the draft; null for others. */
  draft: JobArchitectureDraft | null;
}
export interface BracketState {
  current: SalaryBracketVersion | null;
  draft: SalaryBracketVersion | null;
}
export type JobView = "grades" | "titles" | "families";
export type JobForm =
  | { kind: "grade"; grade: Grade | null }
  | { kind: "title"; title: Title | null }
  | { kind: "family"; family: Family | null };
export interface JobValues {
  name: string;
  /** A family or title key; on add it follows the name until it is edited. */
  key: string;
  code: string;
  order: string;
  familyKey: string;
  gradeCode: string;
}
export interface BracketRow {
  gradeCode: string;
  minimum: string;
  midpoint: string;
  maximum: string;
}
export interface BracketValues {
  payPeriod: PayPeriod;
  covers: BracketCover;
  effectiveFrom: string;
  rows: BracketRow[];
}
/** A title's grade change awaiting confirmation: what uses the title, and the two grade codes. */
export interface TitleImpact {
  usage: JobTitleUsage;
  from: string;
  to: string;
}
export interface JobHandlers {
  view: (view: JobView) => void;
  open: (form: JobForm) => void;
  publish: () => void;
  showBrackets: (on: boolean) => void;
  editBrackets: () => void;
  publishBrackets: () => void;
}

export const JOB_ARCHITECTURE_PATH = "/api/v1/job-architecture";
export const SALARY_BRACKETS_PATH = "/api/v1/salary-brackets";
export const JOB_TITLE_USAGE_PATH = `${JOB_ARCHITECTURE_PATH}/usage`;
const JOB_VIEWS: [JobView, string][] = [
  ["grades", "Job grades & salary brackets"],
  ["titles", "Job titles"],
  ["families", "Job families"],
];
const PAY_PERIOD_LABELS: Record<PayPeriod, string> = {
  monthly: "Monthly",
  annual: "Annual",
};
export const PER_PERIOD: Record<PayPeriod, string> = {
  monthly: "AED a month",
  annual: "AED a year",
};
export const COVER_LABELS: Record<BracketCover, string> = {
  basic: "Basic salary only",
  "basic-housing-transport": "Basic + housing + transport",
  "total-cash": "Total cash",
};
export const CONFIDENTIAL_NOTICE =
  "Salary brackets are visible only to people a company owner has given Plan & pay access in Company authority; company owners need it too. Everyone else sees grades without pay. Brackets are never sent to AI tools, exports, notifications, search or activity.";
export const AMOUNT_ERROR =
  "Enter each amount in AED, such as 15000 or 15000.50, from 0.01 to 1,000,000,000.";
export const BRACKET_ORDER_ERROR =
  "The minimum must be at most the midpoint, and the midpoint at most the maximum.";
const EMPTY_BODY: JobArchitectureBody = {
  families: [],
  grades: [],
  titles: [],
};

/** Opening the panel: the job architecture only, never the salary brackets. */
export const loadJobArchitecture = (request: Requester) =>
  request<{ data: JobArchitectureState }>(JOB_ARCHITECTURE_PATH).then(
    (found) => found.data,
  );
/**
 * The salary brackets, only for Plan & pay access with plans:read; without it nothing is requested.
 * The figures stay in the panel's state, never in the URL, storage or the workspace data cache.
 */
export async function loadSalaryBrackets(
  request: Requester,
  access: Pick<MeAccess, "planAccess">,
): Promise<BracketState | null> {
  if (!access.planAccess.read) return null;
  return (await request<{ data: BracketState }>(SALARY_BRACKETS_PATH)).data;
}
const send = (
  request: Requester,
  path: string,
  method: string,
  body: unknown,
) => request(path, { method, body: JSON.stringify(body) });
/** Saves the next body into the one draft, or makes the draft when there is none. */
export const saveJobArchitecture = (
  request: Requester,
  state: JobArchitectureState,
  body: JobArchitectureBody,
) =>
  state.draft
    ? send(request, `${JOB_ARCHITECTURE_PATH}/${state.draft.id}`, "PUT", {
        body,
      })
    : send(request, JOB_ARCHITECTURE_PATH, "POST", { body });
/** Counts only, of what uses one title across the company; asked for only before a grade change. */
export const loadTitleUsage = (request: Requester, key: string) =>
  request<{ data: JobTitleUsage }>(
    `${JOB_TITLE_USAGE_PATH}?titleKey=${encodeURIComponent(key)}`,
  ).then((found) => found.data);
/**
 * One step of saving the job form. A grade change of an existing title without its usage yet only
 * asks for the usage and returns it; anything else, or the confirmation with the usage shown, saves
 * the next body into the draft.
 */
export async function stepTitleSave(
  request: Requester,
  state: JobArchitectureState,
  form: JobForm,
  values: JobValues,
  body: JobArchitectureBody,
  usage: JobTitleUsage | null,
): Promise<{ usage: JobTitleUsage } | { saved: true }> {
  if (
    form.kind === "title" &&
    form.title &&
    values.gradeCode !== form.title.gradeCode &&
    !usage
  )
    return { usage: await loadTitleUsage(request, form.title.key) };
  await saveJobArchitecture(request, state, body);
  return { saved: true };
}
const plural = (count: number, one: string, many: string) =>
  `${formatNumber(count)} ${count === 1 ? one : many}`;
/** The impact notice's words; the counts cover every team of the company. */
export function impactText(name: string, impact: TitleImpact) {
  const { positions, openVacancies, openOffers } = impact.usage;
  if (!positions && !openVacancies && !openOffers)
    return `No current position, open vacancy or open offer uses ${name}. The new grade applies once the job architecture is published.`;
  return `Changing ${name} from ${impact.from} to ${impact.to} affects ${plural(positions, "position", "positions")}, ${plural(openVacancies, "open vacancy", "open vacancies")} and ${plural(openOffers, "open offer", "open offers")} across the company. They follow the new grade once the job architecture is published.`;
}
/** Exactly the expected codes, each once, as the bracket service compares them. */
const sameCodes = (codes: string[], expected: string[]) => {
  const held = new Set(codes);
  return (
    held.size === codes.length &&
    codes.length === expected.length &&
    expected.every((code) => held.has(code))
  );
};
/** A bracket draft made for the published grades, which can still be edited and published. */
export const currentDraft = (brackets: BracketState, codes: string[]) =>
  brackets.draft?.state === "draft" &&
  sameCodes(
    brackets.draft.brackets.map((bracket) => bracket.gradeCode),
    codes,
  )
    ? brackets.draft
    : null;
/** A draft for the published grades is edited; otherwise a new draft is made. Never a published version. */
export function saveSalaryBrackets(
  request: Requester,
  brackets: BracketState,
  codes: string[],
  input: SalaryBracketInput,
) {
  const draft = currentDraft(brackets, codes);
  return draft
    ? send(request, `${SALARY_BRACKETS_PATH}/${draft.versionId}`, "PUT", input)
    : send(request, SALARY_BRACKETS_PATH, "POST", input);
}

/** Editors see the draft when there is one; everyone else only the published version. */
export const shownBody = (
  state: JobArchitectureState,
  editable: boolean,
): JobArchitectureBody | null =>
  editable && state.draft
    ? (state.draft.body as JobArchitectureBody)
    : (state.current?.body ?? null);
export const gradesInOrder = (body: JobArchitectureBody) =>
  [...body.grades].sort((a, b) => a.order - b.order);
/** A key from a name that fits configKey: lowercase letters, digits and hyphens, at most 63. */
export const keyFor = (name: string) =>
  slugFor(name).slice(0, 63).replace(/-+$/, "");

/** AED as typed, whole or with one or two decimals, to fils by string arithmetic only. */
export function aedToFils(text: string): number {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error(AMOUNT_ERROR);
  const fils = Number(`${match[1]}${(match[2] ?? "").padEnd(2, "0")}`);
  if (fils < 1 || fils > 100_000_000_000) throw new Error(AMOUNT_ERROR);
  return fils;
}
/** Fils as AED with thousands separators, with two decimals only when there are fils. */
export function filsToAed(fils: number) {
  const rest = fils % 100;
  return `${formatNumber((fils - rest) / 100)}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}
/** Fils as an input value: no separators, so aedToFils reads it back. */
const filsToInput = (fils: number) => {
  const rest = fils % 100;
  return `${(fils - rest) / 100}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
};
/**
 * The dialog's rows as brackets in fils, or the plain-words refusal naming the grade codes; checked
 * before any request, and the service and database check the order again.
 */
export function checkBracketRows(rows: BracketRow[]): {
  error: string;
  brackets: SalaryBracket[];
} {
  const brackets: SalaryBracket[] = [];
  for (const row of rows) {
    try {
      brackets.push({
        gradeCode: row.gradeCode,
        minimumFils: aedToFils(row.minimum),
        midpointFils: aedToFils(row.midpoint),
        maximumFils: aedToFils(row.maximum),
      });
    } catch {
      return { error: `Grade ${row.gradeCode}: ${AMOUNT_ERROR}`, brackets: [] };
    }
  }
  const wrong = brackets
    .filter(
      (b) => b.minimumFils > b.midpointFils || b.midpointFils > b.maximumFils,
    )
    .map((b) => b.gradeCode);
  return wrong.length
    ? {
        error: `${wrong.length > 1 ? "Grades" : "Grade"} ${wrong.join(", ")}: ${BRACKET_ORDER_ERROR}`,
        brackets: [],
      }
    : { error: "", brackets };
}
/**
 * The dialog's start: the draft made for the published grades, else the published version, matched
 * by code, else empty; monthly and basic salary only when neither exists (D23).
 */
export function bracketPrefill(
  grades: Grade[],
  brackets: BracketState,
): BracketValues {
  const source =
    currentDraft(
      brackets,
      grades.map((grade) => grade.code),
    ) ?? brackets.current;
  const held = new Map(
    (source?.brackets ?? []).map((bracket) => [bracket.gradeCode, bracket]),
  );
  return {
    payPeriod: source?.payPeriod ?? "monthly",
    covers: source?.covers ?? "basic",
    effectiveFrom: source?.effectiveFrom ?? "",
    rows: grades.map((grade) => {
      const bracket = held.get(grade.code);
      return {
        gradeCode: grade.code,
        minimum: bracket ? filsToInput(bracket.minimumFils) : "",
        midpoint: bracket ? filsToInput(bracket.midpointFils) : "",
        maximum: bracket ? filsToInput(bracket.maximumFils) : "",
      };
    }),
  };
}

const nameError = (name: string) =>
  !name.trim()
    ? "Enter a name."
    : name.trim().length > 120
      ? "A name can be at most 120 characters."
      : "";
const KEY_ERROR =
  "Use lowercase letters, digits and hyphens for the key, at most 63, starting with a letter or digit.";
/** The grade form's refusal before sending, or "". */
export function gradeError(
  body: JobArchitectureBody,
  values: Pick<JobValues, "name" | "code" | "order">,
  editing: Grade | null,
) {
  const others = body.grades.filter((grade) => grade.code !== editing?.code);
  const order = Number(values.order);
  if (!editing && body.grades.length >= 200)
    return "A job architecture holds at most 200 grades.";
  const error = nameError(values.name);
  if (error) return error;
  if (!editing && !gradeCode.safeParse(values.code).success)
    return "Use capital letters, digits and hyphens for the code, at most 20, starting with a letter or digit, such as G7.";
  if (!editing && others.some((grade) => grade.code === values.code))
    return "Another grade already uses this code.";
  if (!/^\d+$/.test(values.order.trim()) || order < 1 || order > 1000)
    return "Enter the order as a whole number from 1 to 1000.";
  if (others.some((grade) => grade.order === order))
    return "Another grade already uses this order.";
  return "";
}
/** The job title form's refusal before sending, or "". */
export function titleError(
  body: JobArchitectureBody,
  values: Pick<JobValues, "name" | "key" | "familyKey" | "gradeCode">,
  editing: Title | null,
) {
  if (!editing && body.titles.length >= 2000)
    return "A job architecture holds at most 2,000 job titles.";
  const error = nameError(values.name);
  if (error) return error;
  if (!editing && !configKey.safeParse(values.key).success) return KEY_ERROR;
  if (!editing && body.titles.some((title) => title.key === values.key))
    return "Another job title already uses this key.";
  if (!body.families.some((family) => family.key === values.familyKey))
    return "Choose a job family.";
  if (!body.grades.some((grade) => grade.code === values.gradeCode))
    return "Choose a job grade.";
  return "";
}
/** The job family form's refusal before sending, or "". */
export function familyError(
  body: JobArchitectureBody,
  values: Pick<JobValues, "name" | "key">,
  editing: Family | null,
) {
  if (!editing && body.families.length >= 200)
    return "A job architecture holds at most 200 job families.";
  const error = nameError(values.name);
  if (error) return error;
  if (!editing && !configKey.safeParse(values.key).success) return KEY_ERROR;
  if (!editing && body.families.some((family) => family.key === values.key))
    return "Another job family already uses this key.";
  return "";
}
export const formError = (
  body: JobArchitectureBody,
  form: JobForm,
  values: JobValues,
) =>
  form.kind === "grade"
    ? gradeError(body, values, form.grade)
    : form.kind === "title"
      ? titleError(body, values, form.title)
      : familyError(body, values, form.family);
/** The shown body plus the one change; codes and keys never change once added. */
export function nextBody(
  body: JobArchitectureBody,
  form: JobForm,
  values: JobValues,
): JobArchitectureBody {
  const name = values.name.trim();
  switch (form.kind) {
    case "grade": {
      const grade = {
        code: form.grade?.code ?? values.code,
        name,
        order: Number(values.order),
      };
      return {
        ...body,
        grades: form.grade
          ? body.grades.map((item) => (item.code === grade.code ? grade : item))
          : [...body.grades, grade],
      };
    }
    case "title": {
      const title = {
        key: form.title?.key ?? values.key,
        name,
        familyKey: values.familyKey,
        gradeCode: values.gradeCode,
      };
      return {
        ...body,
        titles: form.title
          ? body.titles.map((item) => (item.key === title.key ? title : item))
          : [...body.titles, title],
      };
    }
    case "family": {
      const family = { key: form.family?.key ?? values.key, name };
      return {
        ...body,
        families: form.family
          ? body.families.map((item) =>
              item.key === family.key ? family : item,
            )
          : [...body.families, family],
      };
    }
  }
}

/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);
// A table's actions stay on one line; the column is as narrow as its buttons.
const actionCell = { width: "1%", whiteSpace: "nowrap" } as const;
// As on the Levels table: the button never breaks inside its word.
const actionRow = {
  flexWrap: "nowrap",
  overflowWrap: "normal",
  gap: 8,
} as const;

/**
 * Job architecture on Organisation (ADM-26): job grades, job titles and job families, edited as a
 * draft and published by company owners and company admins with organisation. Salary brackets
 * load only when a Plan & pay access holder turns on Show salary brackets.
 */
export function JobArchitecturePanel({
  access,
  request,
}: {
  access: MeAccess;
  request: Requester | null;
}) {
  const editable = access.adminAreas.includes("organisation");
  const [state, setState] = useState<JobArchitectureState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<JobView>("grades");
  const [form, setForm] = useState<JobForm | null>(null);
  const [showing, setShowing] = useState(false);
  const shown = useRef(false);
  const [brackets, setBrackets] = useState<BracketState | null>(null);
  const [bracketError, setBracketError] = useState("");
  const [editingBrackets, setEditingBrackets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const freshSession = useFreshSession();
  // Publishing removes its button; focus goes to the notice instead.
  const [noticeRef, focusNotice] = useFocusAfter<HTMLParagraphElement>();
  const publishedGrades = state?.current
    ? gradesInOrder(state.current.body)
    : [];
  const publishedCodes = publishedGrades.map((grade) => grade.code);
  // A team change starts again with the switch off and no figures held.
  const [teamRequest, setTeamRequest] = useState(() => request);
  if (teamRequest !== request) {
    setTeamRequest(() => request);
    setShowing(false);
    setBrackets(null);
    setBracketError("");
    setEditingBrackets(false);
  }

  useEffect(() => {
    if (!request) return;
    let active = true;
    loadJobArchitecture(request)
      .then((found) => {
        if (active) setState(found);
      })
      .catch((e) => {
        if (active) setLoadError(humanError(e));
      });
    return () => {
      active = false;
      // Bracket figures still loading for the previous team are dropped.
      shown.current = false;
    };
  }, [request]);

  async function reload() {
    if (!request) return;
    setState(await loadJobArchitecture(request));
  }
  async function reloadBrackets() {
    if (!request) return;
    setBracketError("");
    try {
      const found = await loadSalaryBrackets(request, access);
      // Figures that arrive after the switch was turned off are dropped.
      if (shown.current) setBrackets(found);
    } catch (e) {
      if (shown.current) setBracketError(plainError(e));
    }
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }
  /** After the open form saved its next body; a refusal throws in the dialog, so it shows it. */
  async function saved() {
    await reload();
    setNotice("");
    setForm(null);
  }
  async function saveBrackets(input: SalaryBracketInput) {
    if (!request || !brackets) return;
    await saveSalaryBrackets(request, brackets, publishedCodes, input);
    await reloadBrackets();
    setNotice("");
    setEditingBrackets(false);
  }

  const on: JobHandlers = {
    view: setView,
    open: setForm,
    publish() {
      const draft = state?.draft;
      if (!request || !draft) return;
      void run(async () => {
        const published = await request<{ data: { number: number } }>(
          `${JOB_ARCHITECTURE_PATH}/${draft.id}/publish`,
          { method: "POST" },
        );
        await reload();
        if (shown.current) await reloadBrackets();
        focusNotice();
        setNotice(
          `Published job architecture version ${published.data.number}.`,
        );
      });
    },
    showBrackets(value) {
      shown.current = value;
      setShowing(value);
      setBrackets(null);
      setBracketError("");
      if (value) void reloadBrackets();
    },
    editBrackets() {
      setEditingBrackets(true);
    },
    publishBrackets() {
      const draft = brackets && currentDraft(brackets, publishedCodes);
      if (!request || !draft) return;
      void run(async () => {
        const published = await freshSession.withFreshSession(() =>
          request<{ data: { number: number } }>(
            `${SALARY_BRACKETS_PATH}/${draft.versionId}/publish`,
            { method: "POST" },
          ),
        );
        if (published === REAUTH_CANCELLED) return;
        await reloadBrackets();
        focusNotice();
        setNotice(`Published salary bracket version ${published.data.number}.`);
      });
    },
  };
  const body = state ? shownBody(state, editable) : null;
  // The editor's draft holds grades the published version does not.
  const newGrades =
    !!body &&
    editable &&
    !!state?.draft &&
    body.grades.some((grade) => !publishedCodes.includes(grade.code));
  return (
    <>
      <JobArchitectureView
        access={access}
        state={state}
        loadError={loadError}
        view={view}
        showBrackets={showing}
        brackets={brackets}
        bracketError={bracketError}
        busy={busy}
        error={error}
        notice={notice}
        noticeRef={noticeRef}
        on={on}
      />
      {form && request && state && (
        <JobFormDialog
          form={form}
          body={body ?? EMPTY_BODY}
          request={request}
          state={state}
          onSaved={saved}
          onClose={() => setForm(null)}
        />
      )}
      {editingBrackets && brackets && (
        <SalaryBracketsDialog
          initial={bracketPrefill(publishedGrades, brackets)}
          grades={publishedGrades}
          newGrades={newGrades}
          onSubmit={saveBrackets}
          onClose={() => setEditingBrackets(false)}
        />
      )}
      {freshSession.dialog}
    </>
  );
}

/** The panel from props: the status line, the three sub-views and, for holders, the brackets. */
export function JobArchitectureView({
  access,
  state,
  loadError = "",
  view = "grades",
  showBrackets = false,
  brackets = null,
  bracketError = "",
  busy = false,
  error = "",
  notice = "",
  noticeRef,
  on = {},
}: {
  access: Pick<MeAccess, "adminAreas" | "planAccess">;
  state: JobArchitectureState | null;
  loadError?: string;
  view?: JobView;
  showBrackets?: boolean;
  brackets?: BracketState | null;
  bracketError?: string;
  busy?: boolean;
  error?: string;
  notice?: string;
  noticeRef?: Ref<HTMLParagraphElement>;
  on?: Partial<JobHandlers>;
}) {
  const editable = access.adminAreas.includes("organisation");
  const body = state ? shownBody(state, editable) : null;
  const draft = editable ? (state?.draft ?? null) : null;
  return (
    <section className="panel stack">
      <h2>Job architecture</h2>
      <p className="muted">
        Job families, job grades and job titles for the whole company. Every
        member can read the published version. Company owners and company admins
        with Organisation change a draft, then publish it.
      </p>
      {loadError ? (
        <p className="notice error" role="alert">
          Could not load the job architecture. {loadError}
        </p>
      ) : !state ? (
        <p role="status">Loading job architecture…</p>
      ) : (
        <>
          {draft ? (
            <div className="row" style={{ alignItems: "center", gap: 12 }}>
              <p>
                A draft is saved and not published yet
                {state.current
                  ? ` (published version ${state.current.number}).`
                  : "."}
              </p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => on.publish?.()}
              >
                Publish job architecture
              </button>
            </div>
          ) : state.current ? (
            <p>Published version {state.current.number}</p>
          ) : (
            <p className="muted">No job architecture is published yet.</p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
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
          {(body || editable) && (
            <JobSubViews
              access={access}
              body={body ?? EMPTY_BODY}
              published={state.current?.body ?? null}
              editable={editable}
              view={view}
              showBrackets={showBrackets}
              brackets={brackets}
              bracketError={bracketError}
              busy={busy}
              on={on}
            />
          )}
        </>
      )}
    </section>
  );
}

function JobSubViews({
  access,
  body,
  published,
  editable,
  view,
  showBrackets,
  brackets,
  bracketError,
  busy,
  on,
}: {
  access: Pick<MeAccess, "planAccess">;
  body: JobArchitectureBody;
  published: JobArchitectureBody | null;
  editable: boolean;
  view: JobView;
  showBrackets: boolean;
  brackets: BracketState | null;
  bracketError: string;
  busy: boolean;
  on: Partial<JobHandlers>;
}) {
  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label="Job architecture"
        onKeyDown={tabKeys}
      >
        {JOB_VIEWS.map(([key, label]) => (
          <button
            type="button"
            role="tab"
            id={`job-tab-${key}`}
            aria-controls={`job-panel-${key}`}
            tabIndex={view === key ? 0 : -1}
            aria-selected={view === key}
            key={key}
            onClick={() => on.view?.(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`job-panel-${view}`}
        aria-labelledby={`job-tab-${view}`}
        tabIndex={0}
        className="stack"
      >
        {view === "grades" ? (
          <GradesView
            access={access}
            body={body}
            published={published}
            editable={editable}
            showBrackets={showBrackets}
            brackets={brackets}
            bracketError={bracketError}
            busy={busy}
            on={on}
          />
        ) : view === "titles" ? (
          <TitlesView body={body} editable={editable} busy={busy} on={on} />
        ) : (
          <FamiliesView body={body} editable={editable} busy={busy} on={on} />
        )}
      </div>
    </>
  );
}

function EditButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <td data-label="Actions" style={actionCell}>
      <div className="row" style={actionRow}>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          aria-label={`Edit: ${label}`}
          onClick={onClick}
        >
          Edit
        </button>
      </div>
    </td>
  );
}

function AddButton({
  label,
  busy,
  disabled = false,
  hint,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <div className="row" style={{ alignItems: "center", gap: 12 }}>
      <button
        type="button"
        className="button secondary"
        disabled={busy || disabled}
        aria-describedby={disabled && hint ? "job-add-hint" : undefined}
        onClick={onClick}
      >
        {label}
      </button>
      {disabled && hint && (
        <p id="job-add-hint" className="muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Grades by order. With Show salary brackets on, the published bracket version adds its figures
 * and band after Order; the switch exists only for Plan & pay access with plans:read.
 */
export function GradesView({
  access,
  body,
  published,
  editable,
  showBrackets = false,
  brackets = null,
  bracketError = "",
  busy = false,
  on = {},
}: {
  access: Pick<MeAccess, "planAccess">;
  body: JobArchitectureBody;
  published: JobArchitectureBody | null;
  editable: boolean;
  showBrackets?: boolean;
  brackets?: BracketState | null;
  bracketError?: string;
  busy?: boolean;
  on?: Partial<JobHandlers>;
}) {
  const grades = gradesInOrder(body);
  const holder = access.planAccess.read;
  const version = holder && showBrackets ? (brackets?.current ?? null) : null;
  const figures = new Map(
    (version?.brackets ?? []).map((bracket) => [bracket.gradeCode, bracket]),
  );
  const top = Math.max(
    1,
    ...(version?.brackets ?? []).map((bracket) => bracket.maximumFils),
  );
  const per = version ? PER_PERIOD[version.payPeriod] : "";
  return (
    <>
      <p className="notice">
        <strong>Confidential.</strong> {CONFIDENTIAL_NOTICE}
      </p>
      {holder && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            role="switch"
            checked={showBrackets}
            onChange={(event) => on.showBrackets?.(event.target.checked)}
          />
          Show salary brackets
        </label>
      )}
      {holder && showBrackets && (
        <BracketControls
          access={access}
          published={published}
          editable={editable}
          brackets={brackets}
          bracketError={bracketError}
          busy={busy}
          on={on}
        />
      )}
      {!grades.length ? (
        <p className="muted">No job grades yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">
              Job grades, lowest order first
            </caption>
            <thead>
              <tr>
                <th>Grade</th>
                <th>Name</th>
                <th>Order</th>
                {version && (
                  <>
                    <th>{`Minimum (${per})`}</th>
                    <th>{`Midpoint (${per})`}</th>
                    <th>{`Maximum (${per})`}</th>
                    <th>Range</th>
                  </>
                )}
                <th>Job titles</th>
                {editable && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {grades.map((grade) => {
                const bracket = figures.get(grade.code);
                return (
                  <tr key={grade.code}>
                    <td data-label="Grade">{grade.code}</td>
                    <td data-label="Name">{grade.name}</td>
                    <td data-label="Order">{grade.order}</td>
                    {version &&
                      (bracket ? (
                        <>
                          <td data-label={`Minimum (${per})`}>
                            {filsToAed(bracket.minimumFils)}
                          </td>
                          <td data-label={`Midpoint (${per})`}>
                            {filsToAed(bracket.midpointFils)}
                          </td>
                          <td data-label={`Maximum (${per})`}>
                            {filsToAed(bracket.maximumFils)}
                          </td>
                          <td data-label="Range">
                            <BracketBand bracket={bracket} top={top} />
                          </td>
                        </>
                      ) : (
                        <td data-label="Salary bracket" colSpan={4}>
                          No bracket
                        </td>
                      ))}
                    <td data-label="Job titles">
                      {
                        body.titles.filter(
                          (title) => title.gradeCode === grade.code,
                        ).length
                      }
                    </td>
                    {editable && (
                      <EditButton
                        label={grade.code}
                        busy={busy}
                        onClick={() => on.open?.({ kind: "grade", grade })}
                      />
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <AddButton
          label="Add grade"
          busy={busy}
          onClick={() => on.open?.({ kind: "grade", grade: null })}
        />
      )}
    </>
  );
}

/** The bracket band, scaled to the version's highest maximum, with the midpoint marked. */
export function BracketBand({
  bracket,
  top,
}: {
  bracket: SalaryBracket;
  top: number;
}) {
  const at = (fils: number) => (fils / top) * 100;
  return (
    <div
      className="bracket-band"
      role="img"
      aria-label={`AED ${filsToAed(bracket.minimumFils)} to AED ${filsToAed(bracket.maximumFils)}, midpoint AED ${filsToAed(bracket.midpointFils)}`}
    >
      <span
        className="bracket-band-range"
        style={{
          left: `${at(bracket.minimumFils)}%`,
          right: `${100 - at(bracket.maximumFils)}%`,
        }}
      />
      <span
        className="bracket-band-midpoint"
        style={{ left: `${at(bracket.midpointFils)}%` }}
      />
    </div>
  );
}

/** The summary line and, for writers, the draft status and the bracket actions. */
function BracketControls({
  access,
  published,
  editable,
  brackets,
  bracketError,
  busy,
  on,
}: {
  access: Pick<MeAccess, "planAccess">;
  published: JobArchitectureBody | null;
  editable: boolean;
  brackets: BracketState | null;
  bracketError: string;
  busy: boolean;
  on: Partial<JobHandlers>;
}) {
  if (bracketError)
    return (
      <p className="notice error" role="alert">
        Could not load the salary brackets. {bracketError}
      </p>
    );
  if (!brackets) return <p role="status">Loading salary brackets…</p>;
  const version = brackets.current;
  const codes = published ? published.grades.map((grade) => grade.code) : [];
  const draft = currentDraft(brackets, codes);
  const writer = access.planAccess.write && editable;
  return (
    <>
      <p className="muted">
        {version
          ? `Brackets in AED, ${PAY_PERIOD_LABELS[version.payPeriod].toLowerCase()}, ${COVER_LABELS[version.covers].toLowerCase()} · effective ${formatDate(version.effectiveFrom)} · version ${version.number}`
          : "No salary brackets are published yet."}
      </p>
      {writer && (
        <>
          {draft ? (
            <p>A salary bracket draft is saved and not published yet.</p>
          ) : (
            brackets.draft && (
              <p>
                This draft was made for other job grades. Saving brackets makes
                a new draft.
              </p>
            )
          )}
          {codes.length ? (
            <div className="row" style={{ gap: 12 }}>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => on.editBrackets?.()}
              >
                Edit salary brackets
              </button>
              {draft && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => on.publishBrackets?.()}
                >
                  Publish salary brackets
                </button>
              )}
            </div>
          ) : (
            <p className="muted">
              Publish a job architecture with at least one grade first.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function TitlesView({
  body,
  editable,
  busy = false,
  on = {},
}: {
  body: JobArchitectureBody;
  editable: boolean;
  busy?: boolean;
  on?: Partial<JobHandlers>;
}) {
  const families = new Map(body.families.map((f) => [f.key, f.name]));
  const grades = new Map(body.grades.map((g) => [g.code, g.name]));
  return (
    <>
      {!body.titles.length ? (
        <p className="muted">No job titles yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Job titles</caption>
            <thead>
              <tr>
                <th>Job title</th>
                <th>Key</th>
                <th>Family</th>
                <th>Grade</th>
                {editable && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {body.titles.map((title) => (
                <tr key={title.key}>
                  <td data-label="Job title">{title.name}</td>
                  <td data-label="Key">{title.key}</td>
                  <td data-label="Family">
                    {families.get(title.familyKey) ?? title.familyKey}
                  </td>
                  <td data-label="Grade">
                    {title.gradeCode} · {grades.get(title.gradeCode) ?? ""}
                  </td>
                  {editable && (
                    <EditButton
                      label={title.name}
                      busy={busy}
                      onClick={() => on.open?.({ kind: "title", title })}
                    />
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <AddButton
          label="Add job title"
          busy={busy}
          disabled={!body.families.length || !body.grades.length}
          hint="Add a job family and a job grade first."
          onClick={() => on.open?.({ kind: "title", title: null })}
        />
      )}
    </>
  );
}

export function FamiliesView({
  body,
  editable,
  busy = false,
  on = {},
}: {
  body: JobArchitectureBody;
  editable: boolean;
  busy?: boolean;
  on?: Partial<JobHandlers>;
}) {
  return (
    <>
      {!body.families.length ? (
        <p className="muted">No job families yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Job families</caption>
            <thead>
              <tr>
                <th>Family</th>
                <th>Key</th>
                <th>Job titles</th>
                {editable && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {body.families.map((family) => (
                <tr key={family.key}>
                  <td data-label="Family">{family.name}</td>
                  <td data-label="Key">{family.key}</td>
                  <td data-label="Job titles">
                    {
                      body.titles.filter(
                        (title) => title.familyKey === family.key,
                      ).length
                    }
                  </td>
                  {editable && (
                    <EditButton
                      label={family.name}
                      busy={busy}
                      onClick={() => on.open?.({ kind: "family", family })}
                    />
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && (
        <AddButton
          label="Add job family"
          busy={busy}
          onClick={() => on.open?.({ kind: "family", family: null })}
        />
      )}
    </>
  );
}

const startValues = (form: JobForm): JobValues => ({
  name:
    form.kind === "grade"
      ? (form.grade?.name ?? "")
      : form.kind === "title"
        ? (form.title?.name ?? "")
        : (form.family?.name ?? ""),
  key: "",
  code: "",
  order: form.kind === "grade" && form.grade ? String(form.grade.order) : "",
  familyKey: form.kind === "title" ? (form.title?.familyKey ?? "") : "",
  gradeCode: form.kind === "title" ? (form.title?.gradeCode ?? "") : "",
});
const jobFormTitles: Record<JobForm["kind"], [string, string, string]> = {
  grade: ["Add grade", "Edit grade", "Save grade"],
  title: ["Add job title", "Edit job title", "Save job title"],
  family: ["Add job family", "Edit job family", "Save job family"],
};

/**
 * One grade, title or family in a dialog; the client check runs first and sends nothing on a refusal.
 * A title's grade change first shows its impact, and saves only on Change grade and save.
 */
function JobFormDialog({
  form,
  body,
  request,
  state,
  onSaved,
  onClose,
}: {
  form: JobForm;
  body: JobArchitectureBody;
  request: Requester;
  state: JobArchitectureState;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<JobValues>(() => startValues(form));
  const [keyEdited, setKeyEdited] = useState(false);
  const [impact, setImpact] = useState<TitleImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [impactRef, focusImpact] = useFocusAfter<HTMLParagraphElement>();
  const set = (change: Partial<JobValues>) =>
    setValues((current) => ({ ...current, ...change }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const refusal = formError(body, form, values);
    if (refusal) {
      setError(refusal);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const step = await stepTitleSave(
        request,
        state,
        form,
        values,
        nextBody(body, form, values),
        impact?.usage ?? null,
      );
      if ("usage" in step) {
        setImpact({
          usage: step.usage,
          from: form.kind === "title" ? (form.title?.gradeCode ?? "") : "",
          to: values.gradeCode,
        });
        setBusy(false);
        focusImpact();
        return;
      }
      await onSaved();
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  }
  return (
    <JobFormView
      form={form}
      body={body}
      values={values}
      impact={impact}
      impactRef={impactRef}
      busy={busy}
      error={error}
      onChange={(change) => {
        if (change.key !== undefined) setKeyEdited(true);
        // Another grade asks for the impact again before anything is saved.
        if (change.gradeCode !== undefined) setImpact(null);
        set(
          change.name !== undefined && !keyEdited
            ? { ...change, key: keyFor(change.name) }
            : change,
        );
      }}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

export function JobFormView({
  form,
  body,
  values,
  impact = null,
  impactRef,
  busy = false,
  error = "",
  onChange = () => {},
  onSubmit = (event) => event.preventDefault(),
  onClose = () => {},
}: {
  form: JobForm;
  body: JobArchitectureBody;
  values: JobValues;
  /** A title's grade change awaiting confirmation; the submit button then confirms it. */
  impact?: TitleImpact | null;
  impactRef?: Ref<HTMLParagraphElement>;
  busy?: boolean;
  error?: string;
  onChange?: (change: Partial<JobValues>) => void;
  onSubmit?: (event: FormEvent) => void;
  onClose?: () => void;
}) {
  const editing =
    form.kind === "grade"
      ? form.grade
      : form.kind === "title"
        ? form.title
        : form.family;
  const [addTitle, editTitle, saveLabel] = jobFormTitles[form.kind];
  const subject =
    form.kind === "grade"
      ? form.grade?.code
      : form.kind === "title"
        ? form.title?.name
        : form.family?.name;
  const fixed =
    form.kind === "grade"
      ? form.grade?.code
      : form.kind === "title"
        ? form.title?.key
        : form.family?.key;
  return (
    <FormDialog
      title={editing ? `${editTitle}: ${subject}` : addTitle}
      submitLabel={
        impact ? "Change grade and save" : editing ? saveLabel : addTitle
      }
      busy={busy}
      error={error}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {form.kind === "grade" &&
        (editing ? (
          <p>
            <span className="muted">Code:</span> {fixed}
          </p>
        ) : (
          <HintField
            label="Code"
            hint="Capital letters, digits and hyphens, such as G7. The code cannot be changed once added."
            value={values.code}
            maxLength={20}
            busy={busy}
            onChange={(code) => onChange({ code })}
          />
        ))}
      <label className="field">
        <span>Name</span>
        <input
          aria-required="true"
          maxLength={120}
          value={values.name}
          disabled={busy}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      {form.kind !== "grade" &&
        (editing ? (
          <p>
            <span className="muted">Key:</span> {fixed}
          </p>
        ) : (
          <HintField
            label="Key"
            hint="Lowercase letters, digits and hyphens. The key cannot be changed once added."
            value={values.key}
            maxLength={63}
            busy={busy}
            onChange={(key) => onChange({ key })}
          />
        ))}
      {form.kind === "grade" && (
        <HintField
          label="Order"
          hint="A whole number from 1 to 1000; grades are listed by order, lowest first."
          value={values.order}
          inputMode="numeric"
          busy={busy}
          onChange={(order) => onChange({ order })}
        />
      )}
      {form.kind === "title" && (
        <>
          <label className="field">
            <span>Family</span>
            <select
              aria-required="true"
              value={values.familyKey}
              disabled={busy}
              onChange={(event) => onChange({ familyKey: event.target.value })}
            >
              <option value="">Choose a job family</option>
              {body.families.map((family) => (
                <option key={family.key} value={family.key}>
                  {family.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Grade</span>
            <select
              aria-required="true"
              value={values.gradeCode}
              disabled={busy}
              onChange={(event) => onChange({ gradeCode: event.target.value })}
            >
              <option value="">Choose a job grade</option>
              {gradesInOrder(body).map((grade) => (
                <option key={grade.code} value={grade.code}>
                  {grade.code} · {grade.name}
                </option>
              ))}
            </select>
          </label>
          {impact && form.title && (
            <p ref={impactRef} tabIndex={-1} className="notice" role="status">
              {impactText(form.title.name, impact)}
            </p>
          )}
        </>
      )}
    </FormDialog>
  );
}

/** A text field with its hint as the description, not part of its name. */
function HintField({
  label,
  hint,
  value,
  maxLength,
  inputMode,
  busy,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  maxLength?: number;
  inputMode?: "numeric";
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const hintId = useId();
  return (
    <div className="field">
      <label className="field">
        <span>{label}</span>
        <input
          aria-required="true"
          maxLength={maxLength}
          inputMode={inputMode}
          value={value}
          disabled={busy}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <small id={hintId} className="muted">
        {hint}
      </small>
    </div>
  );
}

/** The bracket settings and every published grade's figures; the row check runs before sending. */
function SalaryBracketsDialog({
  initial,
  grades,
  newGrades,
  onSubmit,
  onClose,
}: {
  initial: BracketValues;
  grades: Grade[];
  newGrades: boolean;
  onSubmit: (input: SalaryBracketInput) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.effectiveFrom)) {
      setError("Enter the date the brackets take effect.");
      return;
    }
    const checked = checkBracketRows(values.rows);
    if (checked.error) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        payPeriod: values.payPeriod,
        covers: values.covers,
        effectiveFrom: values.effectiveFrom,
        brackets: checked.brackets,
      });
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  }
  return (
    <SalaryBracketsForm
      values={values}
      grades={grades}
      newGrades={newGrades}
      busy={busy}
      error={error}
      onChange={(change) => setValues((current) => ({ ...current, ...change }))}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

export function SalaryBracketsForm({
  values,
  grades,
  newGrades = false,
  busy = false,
  error = "",
  onChange = () => {},
  onSubmit = (event) => event.preventDefault(),
  onClose = () => {},
}: {
  values: BracketValues;
  grades: Grade[];
  newGrades?: boolean;
  busy?: boolean;
  error?: string;
  onChange?: (change: Partial<BracketValues>) => void;
  onSubmit?: (event: FormEvent) => void;
  onClose?: () => void;
}) {
  const names = new Map(grades.map((grade) => [grade.code, grade.name]));
  const setRow = (index: number, change: Partial<BracketRow>) =>
    onChange({
      rows: values.rows.map((row, at) =>
        at === index ? { ...row, ...change } : row,
      ),
    });
  const amount = (index: number, field: "minimum" | "midpoint" | "maximum") => (
    <label className="field">
      <span>
        <span className="sr-only">{values.rows[index].gradeCode} </span>
        {field[0].toUpperCase() + field.slice(1)} (AED)
      </span>
      <input
        aria-required="true"
        inputMode="decimal"
        value={values.rows[index][field]}
        disabled={busy}
        onChange={(event) => setRow(index, { [field]: event.target.value })}
      />
    </label>
  );
  return (
    <FormDialog
      title="Salary brackets"
      submitLabel="Save salary brackets"
      busy={busy}
      error={error}
      wide
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {newGrades && (
        <p className="notice">
          Brackets follow the published job grades. Publish the job architecture
          first to add brackets for new grades.
        </p>
      )}
      <fieldset className="stack" style={box} disabled={busy}>
        <legend>Bracket settings</legend>
        <p>Currency: AED</p>
        <div className="form-grid">
          <label className="field">
            <span>Pay period</span>
            <select
              value={values.payPeriod}
              onChange={(event) =>
                onChange({ payPeriod: event.target.value as PayPeriod })
              }
            >
              {Object.entries(PAY_PERIOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>What the bracket covers</span>
            <select
              value={values.covers}
              onChange={(event) =>
                onChange({ covers: event.target.value as BracketCover })
              }
            >
              {Object.entries(COVER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Effective from</span>
            <input
              type="date"
              aria-required="true"
              value={values.effectiveFrom}
              onChange={(event) =>
                onChange({ effectiveFrom: event.target.value })
              }
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="stack" style={box} disabled={busy}>
        <legend>Brackets</legend>
        <p className="muted">
          One bracket for each published grade, in AED, such as 15000 or
          15000.50: the minimum at most the midpoint, and the midpoint at most
          the maximum.
        </p>
        {values.rows.map((row, index) => (
          <div key={row.gradeCode} className="stack" style={{ gap: 8 }}>
            <h3 className="bracket-grade">
              {row.gradeCode} · {names.get(row.gradeCode) ?? ""}
            </h3>
            <div className="bracket-amounts">
              {amount(index, "minimum")}
              {amount(index, "midpoint")}
              {amount(index, "maximum")}
            </div>
          </div>
        ))}
      </fieldset>
    </FormDialog>
  );
}
