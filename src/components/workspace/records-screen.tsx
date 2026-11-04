"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Filter,
  FolderOpen,
  LayoutGrid,
  List,
  LoaderCircle,
  Mail,
  MessageSquare,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Star,
  Users,
  X,
} from "lucide-react";
import {
  RESOURCE_CONFIG,
  kindToResource,
  APPLICATION_STAGES,
  CANDIDATE_STATUSES,
  type RecordDto,
  type ResourceName,
  type ReferenceField,
} from "@/domain/records";
import { CvUpload } from "@/components/cv-upload";
import { downloadVerifiedCv, saveCvBytes } from "@/components/cv-transfer";
import { BulkCvImport } from "./bulk-cv-import";
import { Dialog } from "@/components/ui/dialog";
import { RecordEditor, ReferencePicker } from "./editor";
import { OfferStats } from "./metrics";
import { personalStateMutation } from "./mutation";
import {
  dataOf,
  display,
  recordLabel,
  initials,
  formatDate,
  badgeTone,
  saveCsv,
} from "./helpers";
import {
  useApi,
  useDebounced,
  useWorkspace,
  requestJson,
  humanError,
} from "./client";

export interface ListResponse {
  data: RecordDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}
function tabKeys(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next].focus();
  buttons[next].click();
}
const tableColumns: Partial<Record<ResourceName, string[]>> = {
  candidates: [
    "name",
    "jobTitle",
    "employer",
    "yearsExperience",
    "folderCategories",
    "residenceEmirate",
    "reviewStatus",
  ],
  vacancies: [
    "title",
    "department",
    "status",
    "openings",
    "targetDate",
    "recruiter",
  ],
  "job-roles": ["title", "department", "employmentType", "workMode"],
  applications: ["stage", "source", "owner", "appliedDate"],
  tasks: ["title", "owner", "priority", "dueDate"],
  interviews: ["title", "startAt", "interviewer", "status"],
  offers: ["title", "amount", "currency", "status", "expiryDate"],
  onboarding: ["startDate", "owner", "status"],
  checklist: ["title", "category", "dueDate", "owner", "status"],
  buckets: ["name", "position"],
  "task-fields": ["name", "type", "required"],
};
export const screenDefinitions: Record<
  string,
  { title: string; description: string; resource: ResourceName }
> = {
  candidates: {
    title: "Candidates",
    description: "Your talent directory, with the source details that matter.",
    resource: "candidates",
  },
  shortlist: {
    title: "My shortlist",
    description: "Candidates you have personally saved for a closer look.",
    resource: "candidates",
  },
  vacancies: {
    title: "Open vacancies",
    description: "A clear view of the roles your team is working to fill.",
    resource: "vacancies",
  },
  roles: {
    title: "Job roles",
    description: "Reusable role descriptions to start your next vacancy.",
    resource: "job-roles",
  },
  pipeline: {
    title: "Applications",
    description:
      "Move every conversation forward, one considered step at a time.",
    resource: "applications",
  },
  tasks: {
    title: "Recruitment tasks",
    description: "Your workflow, your buckets, your next steps.",
    resource: "tasks",
  },
  interviews: {
    title: "Interviews",
    description: "Plan conversations and keep the whole team in the loop.",
    resource: "interviews",
  },
  offers: {
    title: "Offers",
    description:
      "Track the details between a good conversation and a decision.",
    resource: "offers",
  },
  onboarding: {
    title: "Onboarding",
    description: "Give every new starter a thoughtful beginning.",
    resource: "onboarding",
  },
  "source-review": {
    title: "Source review",
    description:
      "Resolve missing or ambiguous source information without guessing.",
    resource: "candidates",
  },
};

export function RecordsScreen({ section }: { section: string }) {
  const searchParams = useSearchParams();
  const linkedRecord = searchParams.get("record");
  const linkedChecklist = searchParams.get("checklist");
  const config = screenDefinitions[section];
  const resource = config.resource;
  const { team, role } = useWorkspace();
  const canWrite = !!team && role !== "viewer";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [shortlisted, setShortlisted] = useState(section === "shortlist");
  const [reviewStatus, setReviewStatus] = useState("");
  const [emirate, setEmirate] = useState("");
  const [degree, setDegree] = useState("");
  const [vacancy, setVacancy] = useState("");
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState(
    resource === "candidates" ? "name" : "updatedAt",
  );
  const [direction, setDirection] = useState("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [mode, setMode] = useState<"table" | "cards" | "board">(
    resource === "tasks" || resource === "applications"
      ? "board"
      : resource === "vacancies" || resource === "job-roles"
        ? "cards"
        : "table",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<{
    resource: ResourceName;
    record?: RecordDto;
    prefill?: Record<string, unknown>;
    references?: Partial<Record<ReferenceField, string>>;
  } | null>(null);
  const [detail, setDetail] = useState<RecordDto | null>(null);
  const [bulk, setBulk] = useState(false);
  const [bulkCv, setBulkCv] = useState(false);
  const [settings, setSettings] = useState(false);
  const [saveView, setSaveView] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const debounced = useDebounced(search);
  const params = useMemo(() => {
    const p = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      search: debounced,
      sort,
      direction,
    });
    if (archived) p.set("includeArchived", "true");
    if (status) p.set(resource === "applications" ? "stage" : "status", status);
    if (reviewStatus) p.set("reviewStatus", reviewStatus);
    if (category) p.set("folderCategory", category);
    if (emirate) p.set("residenceEmirate", emirate);
    if (degree) p.set("degreeLevel", degree);
    if (vacancy) p.set("vacancyId", vacancy);
    if (shortlisted) p.set("shortlisted", "true");
    if (categories.length) p.set("categories", JSON.stringify(categories));
    if (skills.length) p.set("skills", JSON.stringify(skills));
    if (section === "source-review") p.set("needsReview", "true");
    return p;
  }, [
    page,
    pageSize,
    debounced,
    sort,
    direction,
    archived,
    status,
    category,
    emirate,
    degree,
    vacancy,
    resource,
    section,
    categories,
    skills,
    shortlisted,
    reviewStatus,
  ]);
  const result = useApi<ListResponse>(`/api/v1/${resource}?${params}`);
  const buckets = useApi<ListResponse>(
    resource === "tasks"
      ? "/api/v1/buckets?pageSize=100&sort=position&direction=asc"
      : null,
  );
  const views = useApi<ListResponse>(
    resource === "candidates" || resource === "applications"
      ? `/api/v1/views?pageSize=100&area=${resource === "candidates" ? "directory" : "applications"}`
      : null,
  );
  // A changed server-side query invalidates page-local selection and pagination together.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A changed query resets its pagination and selection together.
    setPage(1);
    setSelected([]);
  }, [
    debounced,
    status,
    category,
    emirate,
    degree,
    vacancy,
    archived,
    sort,
    direction,
    pageSize,
    categories,
    skills,
    shortlisted,
    reviewStatus,
  ]);
  useEffect(() => {
    let active = true;
    if (team && linkedRecord)
      requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/${resource}/${encodeURIComponent(linkedRecord)}`,
      )
        .then((response) => {
          if (active) setDetail(response.data);
        })
        .catch((error: unknown) => {
          if (active) setError(humanError(error));
        });
    return () => {
      active = false;
    };
  }, [team, resource, linkedRecord]);
  const refresh = () => {
    result.refresh();
    buckets.refresh();
    views.refresh();
    setSelected([]);
  };
  const saved = (record: RecordDto) => {
    setEditor(null);
    setNotice(
      `${RESOURCE_CONFIG[kindToResource[record.kind]].singular} saved.`,
    );
    if (detail?.id === record.id) setDetail(record);
    refresh();
  };
  const move = async (record: RecordDto, value: string) => {
    if (!team) return;
    setError("");
    try {
      await requestJson(team.id, `/api/v1/${resource}/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: record.version,
          ...(resource === "tasks"
            ? { bucketId: value }
            : { data: { stage: value } }),
        }),
      });
      refresh();
      setNotice(
        resource === "tasks" ? "Task moved." : "Application stage updated.",
      );
    } catch (e) {
      setError(humanError(e));
    }
  };
  const applyView = (view: RecordDto) => {
    const q = dataOf(view).query as Record<string, unknown>;
    if (
      resource === "applications" &&
      (q.category ||
        q.emirate ||
        q.degreeLevel ||
        q.reviewStatus ||
        q.shortlisted ||
        (Array.isArray(q.categories) && q.categories.length) ||
        (Array.isArray(q.skills) && q.skills.length))
    ) {
      setError(
        "This saved application view contains candidate-only filters. Edit the view to remove those filters before applying it.",
      );
      return;
    }
    setSearch(String(q.search || ""));
    setCategory(String(q.category || ""));
    setCategories(Array.isArray(q.categories) ? q.categories.map(String) : []);
    setSkills(Array.isArray(q.skills) ? q.skills.map(String) : []);
    setShortlisted(q.shortlisted === true || section === "shortlist");
    setReviewStatus(String(q.reviewStatus || ""));
    setEmirate(String(q.emirate || ""));
    setDegree(String(q.degreeLevel || ""));
    setStatus(String(q.stage || q.status || ""));
    setVacancy(String(q.vacancyId || ""));
    setArchived(!!q.includeArchived);
    setSort(String(q.sort || "updatedAt"));
    setDirection(String(q.direction || "asc"));
    setPageSize(Number(q.pageSize) || 25);
  };
  const exportAll = async () => {
    if (!team) return;
    setExporting(true);
    setError("");
    try {
      const rows: RecordDto[] = [];
      let current = 1;
      let total = 1;
      do {
        const query = new URLSearchParams(params);
        query.set("page", String(current));
        query.set("pageSize", "100");
        const response = await requestJson<ListResponse>(
          team.id,
          `/api/v1/${resource}?${query}`,
        );
        rows.push(...response.data);
        total = response.pagination.totalPages;
        current++;
        if (rows.length > 100000)
          throw new Error("This export is too large. Narrow your filters.");
      } while (current <= total);
      const fields = RESOURCE_CONFIG[resource].fields;
      saveCsv(
        `RecruitmentOS-${resource}.csv`,
        [
          "Record ID",
          ...fields.map((f) => f.label),
          "Created at",
          "Updated at",
        ],
        rows.map((r) => [
          r.id,
          ...fields.map((f) => dataOf(r)[f.key]),
          r.createdAt,
          r.updatedAt,
        ]),
      );
      setNotice(
        `Exported ${rows.length} records matching the current filters.`,
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setExporting(false);
    }
  };
  const columns =
    tableColumns[resource] ||
    RESOURCE_CONFIG[resource].fields.slice(0, 5).map((field) => field.key);
  const stateOptions =
    resource === "applications"
      ? APPLICATION_STAGES
      : RESOURCE_CONFIG[resource].fields.find((field) => field.key === "status")
          ?.options || [];
  if (!team) return <NoTeam />;
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {resource === "candidates"
              ? "Your talent pool"
              : "Recruitment workspace"}
          </p>
          <h1>
            {config.title}
            {result.data && (
              <span className="heading-count">
                {result.data.pagination.total.toLocaleString()}
              </span>
            )}
          </h1>
          <p>{config.description}</p>
        </div>
        <div className="row">
          {resource === "candidates" && (
            <button
              className="button secondary"
              disabled={!canWrite}
              onClick={() => setBulkCv(true)}
            >
              <FileText size={17} aria-hidden="true" />
              Import CVs
            </button>
          )}
          {resource === "tasks" && (
            <button
              className="button secondary"
              onClick={() => setSettings(true)}
            >
              <Filter size={17} aria-hidden="true" />
              Customize workflow
            </button>
          )}
          <button
            className="button"
            disabled={!canWrite}
            onClick={() => setEditor({ resource })}
          >
            <Plus size={17} aria-hidden="true" />
            Add {RESOURCE_CONFIG[resource].singular.toLowerCase()}
          </button>
        </div>
      </div>
      {notice && (
        <div className="notice success" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {resource === "candidates" && (
        <div className="directory-note">
          <FileText size={18} aria-hidden="true" />
          <p>
            Candidate records and CV files are counted separately. Multiple CV
            versions can belong to the same person.{" "}
            <Link href="/app/insights">
              View data coverage
              <ArrowUpRight size={13} aria-hidden="true" />
            </Link>
          </p>
        </div>
      )}
      {resource === "offers" && <OfferStats />}
      <section className="panel records-panel">
        <div className="records-toolbar">
          <div className="search-field">
            <Search size={18} aria-hidden="true" />
            <input
              aria-label={`Search ${config.title.toLowerCase()}`}
              placeholder={
                resource === "candidates"
                  ? "Search name, email, skills or keywords…"
                  : `Search ${config.title.toLowerCase()}…`
              }
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="row toolbar-options">
            {views.data && (
              <select
                aria-label="Apply a saved view"
                value=""
                onChange={(e) => {
                  const v = views.data?.data.find(
                    (item) => item.id === e.target.value,
                  );
                  if (v) applyView(v);
                }}
              >
                <option value="">Saved views</option>
                {views.data.data.map((item) => (
                  <option value={item.id} key={item.id}>
                    {recordLabel(item)}
                  </option>
                ))}
              </select>
            )}
            {views.data && (
              <button
                className="button secondary"
                onClick={() => setSaveView(true)}
                disabled={!canWrite}
              >
                Save view
              </button>
            )}
            <button
              className="button secondary"
              disabled={exporting || result.loading}
              onClick={exportAll}
            >
              {exporting ? (
                <LoaderCircle className="spin" size={16} aria-hidden="true" />
              ) : (
                <Download size={16} aria-hidden="true" />
              )}
              Export
            </button>
            <div className="view-toggle" aria-label="Display mode">
              {(resource === "applications" || resource === "tasks") && (
                <button
                  aria-label="Board view"
                  aria-pressed={mode === "board"}
                  onClick={() => setMode("board")}
                >
                  <LayoutGrid size={17} />
                </button>
              )}
              <button
                aria-label="Table view"
                aria-pressed={mode === "table"}
                onClick={() => setMode("table")}
              >
                <List size={18} />
              </button>
              <button
                aria-label="Card view"
                aria-pressed={mode === "cards"}
                onClick={() => setMode("cards")}
              >
                <LayoutGrid size={17} />
              </button>
            </div>
            <button
              className="icon-button"
              aria-label="Refresh records"
              onClick={refresh}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </div>
        <div className="filter-bar">
          {stateOptions.length > 0 && (
            <label>
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">
                  All {resource === "applications" ? "stages" : "statuses"}
                </option>
                {stateOptions.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          )}
          {resource === "candidates" && (
            <>
              <label>
                Follow-up status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All follow-up statuses</option>
                  {CANDIDATE_STATUSES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Folder category
                <input
                  value={category}
                  placeholder="Any category"
                  onChange={(e) => setCategory(e.target.value)}
                />
              </label>
              <label>
                Residence emirate
                <select
                  value={emirate}
                  onChange={(e) => setEmirate(e.target.value)}
                >
                  <option value="">All emirates</option>
                  {[
                    "Abu Dhabi",
                    "Dubai",
                    "Sharjah",
                    "Ajman",
                    "Umm Al Quwain",
                    "Ras Al Khaimah",
                    "Fujairah",
                  ].map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                Degree level
                <input
                  value={degree}
                  placeholder="Any degree level"
                  onChange={(e) => setDegree(e.target.value)}
                />
              </label>
              <FilterTags
                label="Any of these folder categories"
                values={categories}
                onChange={setCategories}
              />
              <FilterTags
                label="All of these skills"
                values={skills}
                onChange={setSkills}
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={shortlisted}
                  disabled={section === "shortlist"}
                  onChange={(e) => setShortlisted(e.target.checked)}
                />
                My shortlist only
              </label>
              {section === "source-review" && (
                <label>
                  Review status
                  <input
                    value={reviewStatus}
                    placeholder="Any review status"
                    onChange={(e) => setReviewStatus(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          {resource === "applications" && (
            <div className="filter-reference">
              <ReferencePicker
                kind="vacancy"
                label="Vacancy"
                value={vacancy}
                onChange={setVacancy}
              />
            </div>
          )}
          <label>
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="updatedAt">Last updated</option>
              <option value="createdAt">Date added</option>
              <option value={resource === "candidates" ? "name" : "title"}>
                {resource === "candidates" ? "Name" : "Title"}
              </option>
              {resource === "candidates" && (
                <option value="yearsExperience">Stated experience</option>
              )}
            </select>
          </label>
          <label>
            Order
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Include archived
          </label>
          {(search ||
            status ||
            category ||
            emirate ||
            degree ||
            vacancy ||
            archived ||
            categories.length > 0 ||
            skills.length > 0 ||
            shortlisted ||
            reviewStatus) && (
            <button
              className="text-link"
              onClick={() => {
                setSearch("");
                setStatus("");
                setCategory("");
                setCategories([]);
                setSkills([]);
                setReviewStatus("");
                setShortlisted(section === "shortlist");
                setEmirate("");
                setDegree("");
                setVacancy("");
                setArchived(false);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {selected.length > 0 && (
          <div className="selection-bar">
            <span>
              <strong>{selected.length}</strong> selected on this page
            </span>
            <button
              className="button small"
              onClick={() => setBulk(true)}
              disabled={!canWrite}
            >
              Assign to vacancy
            </button>
            <button
              className="button secondary small"
              onClick={() => setSelected([])}
            >
              Clear selection
            </button>
          </div>
        )}
        {result.error ? (
          <LoadError message={result.error} retry={result.refresh} />
        ) : result.loading ? (
          <Loading />
        ) : !result.data?.data.length ? (
          <EmptyState
            title={
              search || status || category || emirate
                ? "No records match these filters"
                : section === "shortlist"
                  ? "Your shortlist is ready for a first candidate"
                  : `Your ${config.title.toLowerCase()} start here`
            }
            description={
              search || status || category || emirate
                ? "Try a broader search or clear your filters."
                : section === "shortlist"
                  ? "Open a candidate profile and select “Add to my shortlist”."
                  : `Add your first ${RESOURCE_CONFIG[resource].singular.toLowerCase()} to get started.`
            }
            action={
              section === "shortlist" ? (
                <Link href="/app/candidates" className="button">
                  Browse candidates
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              ) : (
                <button
                  className="button"
                  disabled={!canWrite}
                  onClick={() => setEditor({ resource })}
                >
                  <Plus size={16} aria-hidden="true" />
                  Add {RESOURCE_CONFIG[resource].singular.toLowerCase()}
                </button>
              )
            }
          />
        ) : mode === "board" ? (
          <Kanban
            resource={resource}
            records={result.data.data}
            buckets={buckets.data?.data || []}
            onOpen={setDetail}
            onMove={move}
            canWrite={canWrite}
          />
        ) : mode === "cards" ? (
          <div className="record-card-grid">
            {result.data.data.map((record) => (
              <RecordCard
                key={record.id}
                record={record}
                onOpen={() => setDetail(record)}
              />
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {resource === "candidates" && (
                    <th className="checkbox-column">
                      <input
                        type="checkbox"
                        aria-label="Select all candidates on this page"
                        checked={result.data.data.every((r) =>
                          selected.includes(r.id),
                        )}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? result.data!.data.map((r) => r.id)
                              : [],
                          )
                        }
                      />
                    </th>
                  )}
                  {resource === "applications" && (
                    <>
                      <th>Candidate</th>
                      <th>Vacancy</th>
                    </>
                  )}
                  {["interviews", "offers", "onboarding"].includes(
                    resource,
                  ) && <th>Application</th>}
                  {resource === "onboarding" && <th>Checklist progress</th>}
                  {columns.map((key) => (
                    <th key={key}>
                      {RESOURCE_CONFIG[resource].fields.find(
                        (f) => f.key === key,
                      )?.label || key}
                    </th>
                  ))}
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.data.map((record) => (
                  <tr
                    key={record.id}
                    className={record.archivedAt ? "is-archived" : ""}
                  >
                    {resource === "candidates" && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${recordLabel(record)}`}
                          checked={selected.includes(record.id)}
                          onChange={(event) =>
                            setSelected((old) =>
                              event.target.checked
                                ? [...old, record.id]
                                : old.filter((id) => id !== record.id),
                            )
                          }
                        />
                      </td>
                    )}
                    {resource === "applications" && (
                      <>
                        <td>
                          <ReferenceLabel
                            resource="candidates"
                            id={record.candidateId}
                          />
                        </td>
                        <td>
                          <ReferenceLabel
                            resource="vacancies"
                            id={record.vacancyId}
                          />
                        </td>
                      </>
                    )}
                    {["interviews", "offers", "onboarding"].includes(
                      resource,
                    ) && (
                      <td>
                        <ReferenceLabel
                          resource="applications"
                          id={record.applicationId}
                        />
                      </td>
                    )}
                    {resource === "onboarding" && (
                      <td>
                        <OnboardingProgress id={record.id} />
                      </td>
                    )}
                    {columns.map((key, index) => (
                      <td key={key}>
                        {index === 0 ? (
                          <button
                            className="table-record-button"
                            onClick={() => setDetail(record)}
                          >
                            {resource === "candidates" && (
                              <span className="avatar small">
                                {initials(recordLabel(record))}
                              </span>
                            )}
                            <span>
                              <strong>{display(dataOf(record)[key])}</strong>
                              {resource === "candidates" && (
                                <small>
                                  {String(
                                    dataOf(record).email || "No email recorded",
                                  )}
                                </small>
                              )}
                              {record.archivedAt && <small>Archived</small>}
                            </span>
                          </button>
                        ) : key === "status" ||
                          key === "stage" ||
                          key === "priority" ||
                          key === "reviewStatus" ? (
                          <Badge value={dataOf(record)[key]} />
                        ) : key === "folderCategories" ? (
                          <div className="tag-list">
                            {((dataOf(record)[key] as string[]) || [])
                              .slice(0, 3)
                              .map((tag) => (
                                <span className="tag" key={tag}>
                                  {tag}
                                </span>
                              ))}
                            {((dataOf(record)[key] as string[]) || []).length >
                              3 && (
                              <span className="tag">
                                +{(dataOf(record)[key] as string[]).length - 3}
                              </span>
                            )}
                          </div>
                        ) : key.endsWith("Date") || key === "startAt" ? (
                          formatDate(dataOf(record)[key], key === "startAt")
                        ) : (
                          display(dataOf(record)[key])
                        )}
                      </td>
                    ))}
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Open ${recordLabel(record)}`}
                        onClick={() => setDetail(record)}
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.data && (
          <div className="pagination">
            <div className="row">
              <label>
                Show{" "}
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <span className="muted">
                {result.data.pagination.total.toLocaleString()} matching records
                {mode === "board" ? " · board shows this page" : ""}
              </span>
            </div>
            <div className="row">
              <button
                className="icon-button"
                aria-label="Previous page"
                disabled={page <= 1 || result.loading}
                onClick={() => setPage((n) => n - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                Page {page} of {Math.max(1, result.data.pagination.totalPages)}
              </span>
              <button
                className="icon-button"
                aria-label="Next page"
                disabled={
                  page >= result.data.pagination.totalPages || result.loading
                }
                onClick={() => setPage((n) => n + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </section>
      {detail && (
        <RecordDetail
          key={`${detail.id}:${detail.id === linkedRecord ? linkedChecklist || "" : ""}`}
          record={detail}
          initialTab={
            resource === "onboarding" &&
            detail.id === linkedRecord &&
            linkedChecklist
              ? "checklist"
              : "details"
          }
          focusChecklistId={
            detail.id === linkedRecord
              ? linkedChecklist || undefined
              : undefined
          }
          onClose={() => setDetail(null)}
          onEdit={() =>
            setEditor({ resource: kindToResource[detail.kind], record: detail })
          }
          onRefresh={refresh}
          onCreate={(nextResource, refs, prefill) =>
            setEditor({ resource: nextResource, references: refs, prefill })
          }
          onUpdated={(record) => {
            setDetail(record);
            refresh();
          }}
        />
      )}
      {bulkCv && (
        <BulkCvImport
          key={team.id}
          onClose={() => setBulkCv(false)}
          onChanged={refresh}
        />
      )}
      {editor && (
        <RecordEditor
          {...editor}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
      {bulk && (
        <BulkAssign
          candidateIds={selected}
          onClose={() => setBulk(false)}
          onSaved={({ created, skipped }) => {
            setBulk(false);
            refresh();
            setNotice(
              `Assignments saved: ${created} created, ${skipped} already had an active application for this vacancy.`,
            );
          }}
        />
      )}
      {settings && (
        <WorkflowSettings
          onClose={() => {
            setSettings(false);
            refresh();
          }}
        />
      )}
      {saveView && (
        <SaveView
          resource={resource}
          query={{
            search,
            category,
            categories,
            skills,
            shortlisted,
            emirate,
            degreeLevel: degree,
            ...(resource === "applications"
              ? { stage: status || undefined, vacancyId: vacancy || undefined }
              : { status, reviewStatus }),
            includeArchived: archived,
            sort,
            direction,
            pageSize,
          }}
          views={views.data?.data || []}
          onClose={() => setSaveView(false)}
          onSaved={() => {
            setSaveView(false);
            views.refresh();
          }}
        />
      )}
    </div>
  );
}
export function Badge({ value }: { value: unknown }) {
  return <span className={`badge ${badgeTone(value)}`}>{display(value)}</span>;
}
function FilterTags({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="filter-tags">
      <label>
        {label}
        <div className="row">
          <input
            value={draft}
            placeholder="Add a value"
            aria-label={label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (draft.trim()) {
                  onChange([...new Set([...values, draft.trim()])]);
                  setDraft("");
                }
              }
            }}
          />
          <button
            className="icon-button"
            aria-label={`Add ${label.toLowerCase()} filter`}
            type="button"
            disabled={!draft.trim()}
            onClick={() => {
              onChange([...new Set([...values, draft.trim()])]);
              setDraft("");
            }}
          >
            <Plus size={15} />
          </button>
        </div>
      </label>
      {values.length > 0 && (
        <div className="tag-list">
          {values.map((value) => (
            <button
              key={value}
              type="button"
              className="tag"
              aria-label={`Remove ${value} filter`}
              onClick={() => onChange(values.filter((item) => item !== value))}
            >
              {value}
              <X size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={25} className="spin" aria-hidden="true" />
      <span>Loading your workspace…</span>
    </div>
  );
}
export function LoadError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="empty-state">
      <FileText size={28} aria-hidden="true" />
      <h3>We couldn&apos;t load these records</h3>
      <p role="alert">{message}</p>
      <button className="button secondary" onClick={retry}>
        <RefreshCw size={16} aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <FolderOpen size={30} aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function NoTeam() {
  return (
    <section className="panel">
      <EmptyState
        title="A workspace for your team"
        description="Create your first team or accept an invitation to start managing recruitment."
        action={
          <Link className="button" href="/app/settings/team">
            <Users size={17} aria-hidden="true" />
            Create or join a team
          </Link>
        }
      />
    </section>
  );
}
function RecordCard({
  record,
  onOpen,
}: {
  record: RecordDto;
  onOpen: () => void;
}) {
  const d = dataOf(record);
  return (
    <article
      className={`record-card ${record.archivedAt ? "is-archived" : ""}`}
    >
      <div className="row space-between">
        <span className="tag">
          {String(
            d.department ||
              RESOURCE_CONFIG[kindToResource[record.kind]].singular,
          )}
        </span>
        {d.status ? <Badge value={d.status} /> : null}
      </div>
      <button className="card-title" onClick={onOpen}>
        {recordLabel(record)}
      </button>
      {record.kind === "candidate" ? (
        <>
          <p>{String(d.jobTitle || "Job title not recorded")}</p>
          <p className="muted">{String(d.email || "Email not recorded")}</p>
          <div className="tag-list">
            {((d.skills as string[]) || []).slice(0, 4).map((skill) => (
              <span className="tag" key={skill}>
                {skill}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="card-description">
          {String(
            d.description ||
              d.notes ||
              d.context ||
              "Open this record to view its details.",
          )}
        </p>
      )}
      {record.kind === "onboarding" && <OnboardingProgress id={record.id} />}
      <div className="tag-list">
        {[d.employmentType, d.workMode, d.location]
          .filter(Boolean)
          .map((item) => (
            <span className="tag" key={String(item)}>
              {String(item)}
            </span>
          ))}
      </div>
      <footer className="row space-between">
        <span className="muted small-text">
          {d.targetDate
            ? `Target ${formatDate(d.targetDate)}`
            : `Updated ${formatDate(record.updatedAt)}`}
        </span>
        <button
          className="icon-button"
          aria-label={`Open ${recordLabel(record)}`}
          onClick={onOpen}
        >
          <ArrowUpRight size={18} />
        </button>
      </footer>
      {record.archivedAt && <span className="badge">Archived</span>}
    </article>
  );
}
function Kanban({
  resource,
  records,
  buckets,
  onOpen,
  onMove,
  canWrite,
}: {
  resource: ResourceName;
  records: RecordDto[];
  buckets: RecordDto[];
  onOpen: (r: RecordDto) => void;
  onMove: (r: RecordDto, value: string) => void;
  canWrite: boolean;
}) {
  const columns =
    resource === "tasks"
      ? buckets.map((b) => ({
          id: b.id,
          name: String(dataOf(b).name),
          color: String(dataOf(b).color),
        }))
      : APPLICATION_STAGES.map((stage, index) => ({
          id: stage,
          name: stage,
          color: [
            "#D97706",
            "#4338CA",
            "#7C3AED",
            "#2563EB",
            "#059669",
            "#DC2626",
            "#64748B",
          ][index],
        }));
  if (!columns.length)
    return (
      <EmptyState
        title="Your workflow needs its first bucket"
        description="Use Customize workflow to add buckets, then create your first task."
      />
    );
  return (
    <div
      className="kanban"
      aria-label={
        resource === "tasks" ? "Recruitment task board" : "Application pipeline"
      }
    >
      {columns.map((column) => {
        const cards = records.filter((record) =>
          resource === "tasks"
            ? record.bucketId === column.id
            : dataOf(record).stage === column.id,
        );
        return (
          <section
            className="kanban-column"
            key={column.id}
            onDragOver={(e) => {
              if (canWrite) e.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData(
                "text/recruitmentos-record",
              );
              const record = records.find((r) => r.id === id);
              if (record && canWrite) onMove(record, column.id);
            }}
          >
            <h2 style={{ borderTopColor: column.color }}>
              {column.name}
              <span>{cards.length}</span>
            </h2>
            <div className="kanban-cards">
              {cards.map((record) => (
                <article
                  className="kanban-card"
                  draggable={canWrite && !record.archivedAt}
                  onDragStart={(e) =>
                    e.dataTransfer.setData(
                      "text/recruitmentos-record",
                      record.id,
                    )
                  }
                  key={record.id}
                >
                  <button className="card-title" onClick={() => onOpen(record)}>
                    {resource === "applications" ? (
                      <ReferenceLabel
                        resource="candidates"
                        id={record.candidateId}
                        plain
                      />
                    ) : (
                      recordLabel(record)
                    )}
                  </button>
                  {resource === "applications" && (
                    <div className="muted">
                      <ReferenceLabel
                        resource="vacancies"
                        id={record.vacancyId}
                        plain
                      />
                    </div>
                  )}
                  {dataOf(record).owner ? (
                    <p className="muted">
                      Owner: {String(dataOf(record).owner)}
                    </p>
                  ) : null}
                  {resource === "tasks" && (
                    <div className="row space-between">
                      <Badge value={dataOf(record).priority} />
                      <span className="small-text muted">
                        {dataOf(record).dueDate
                          ? formatDate(dataOf(record).dueDate)
                          : "No due date"}
                      </span>
                    </div>
                  )}
                  <footer>
                    <label>
                      <span className="sr-only">
                        Move {recordLabel(record)} to
                      </span>
                      <select
                        aria-label={`Move ${recordLabel(record)} to`}
                        disabled={!canWrite || !!record.archivedAt}
                        value={
                          resource === "tasks"
                            ? record.bucketId || ""
                            : String(dataOf(record).stage)
                        }
                        onChange={(e) => onMove(record, e.target.value)}
                      >
                        {columns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="icon-button"
                      aria-label="Open details"
                      onClick={() => onOpen(record)}
                    >
                      <ArrowUpRight size={16} />
                    </button>
                  </footer>
                </article>
              ))}
              {!cards.length && (
                <p className="board-empty">No records on this page</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
export function ReferenceLabel({
  resource,
  id,
  plain = false,
}: {
  resource: ResourceName;
  id: string | null;
  plain?: boolean;
}) {
  const result = useApi<{ data: RecordDto }>(
    id ? `/api/v1/${resource}/${id}` : null,
  );
  if (!id) return <span className="muted">Not linked</span>;
  const label = result.data
    ? recordLabel(result.data.data)
    : result.loading
      ? "Loading…"
      : `Record ${id.slice(0, 8)}`;
  if (plain || resource !== "candidates")
    return <span title={id}>{label}</span>;
  return <Link href={`/app/candidates/${id}`}>{label}</Link>;
}
function OnboardingProgress({ id }: { id: string }) {
  const result = useApi<ListResponse>(
    `/api/v1/checklist?onboardingId=${id}&pageSize=100`,
  );
  if (result.loading)
    return <small className="muted">Loading checklist…</small>;
  if (result.error)
    return <small className="field-error">Checklist unavailable</small>;
  const items = result.data?.data || [];
  if (!items.length)
    return <small className="muted">Checklist not configured</small>;
  if ((result.data?.pagination.total || 0) > 100)
    return (
      <small className="muted">
        {result.data!.pagination.total} items · open checklist for details
      </small>
    );
  const complete = items.filter((item) =>
    ["Complete", "Waived"].includes(String(dataOf(item).status)),
  ).length;
  return (
    <div className="onboarding-progress">
      <span>
        {complete} / {items.length} complete or waived
      </span>
      <progress
        aria-label="Checklist progress"
        value={complete}
        max={items.length}
      />
    </div>
  );
}
function TaskCustomDetails({ values }: { values: Record<string, unknown> }) {
  const fields = useApi<ListResponse>(
    "/api/v1/task-fields?pageSize=100&includeArchived=true&sort=position",
  );
  return (
    <section className="stack">
      <h3>Custom task fields</h3>
      {fields.error && (
        <p role="alert" className="notice error">
          {fields.error}
        </p>
      )}
      <dl className="detail-facts">
        {Object.entries(values || {}).map(([key, value]) => {
          const field = fields.data?.data.find((item) => item.id === key);
          return (
            <div key={key}>
              <dt>
                {field
                  ? recordLabel(field)
                  : `Archived or unavailable field ${key.slice(0, 8)}`}
                {field?.archivedAt ? " (archived)" : ""}
              </dt>
              <dd>
                {typeof value === "boolean"
                  ? value
                    ? "Yes"
                    : "No"
                  : display(value)}
              </dd>
            </div>
          );
        })}
      </dl>
      {!Object.keys(values || {}).length && (
        <p className="muted">No custom field values recorded.</p>
      )}
    </section>
  );
}

export function RecordDetail({
  record,
  onClose,
  onEdit,
  onRefresh,
  onCreate,
  onUpdated,
  inline = false,
  initialTab = "details",
  focusChecklistId,
}: {
  record: RecordDto;
  onClose: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onCreate: (
    resource: ResourceName,
    refs?: Partial<Record<ReferenceField, string>>,
    prefill?: Record<string, unknown>,
  ) => void;
  onUpdated: (r: RecordDto) => void;
  inline?: boolean;
  initialTab?: "details" | "checklist";
  focusChecklistId?: string;
}) {
  const { team, role } = useWorkspace();
  const [tab, setTab] = useState<string>(initialTab);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [archiveDestination, setArchiveDestination] = useState("");
  const canWrite = role !== "viewer";
  const resource = kindToResource[record.kind];
  const data = dataOf(record);
  const archive = async () => {
    if (!team) return;
    setBusy(true);
    setError("");
    try {
      const response = await requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/${resource}/${record.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            version: record.version,
            archived: !record.archivedAt,
            ...(record.kind === "bucket" && archiveDestination
              ? { moveToBucketId: archiveDestination }
              : {}),
          }),
        },
      );
      onUpdated(response.data);
      onRefresh();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };
  const details = (
    <>
      <div className="detail-summary">
        <div className="row">
          <span className="avatar large">
            {record.kind === "candidate" ? (
              initials(recordLabel(record))
            ) : (
              <FileText size={25} />
            )}
          </span>
          <div>
            <p className="eyebrow">
              {RESOURCE_CONFIG[resource].singular}
              {record.archivedAt ? " · Archived" : ""}
            </p>
            <h2>{recordLabel(record)}</h2>
            <p className="muted">
              {String(data.jobTitle || data.department || data.owner || "")}
            </p>
          </div>
        </div>
        <div className="row">
          {record.kind === "candidate" && (
            <Link
              href={`/app/candidates/${record.id}`}
              className="button secondary"
              onClick={onClose}
            >
              Full profile
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          )}
          <button
            className="button secondary"
            onClick={onEdit}
            disabled={!canWrite}
          >
            Edit details
          </button>
        </div>
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label="Record details"
        onKeyDown={tabKeys}
      >
        {[
          "details",
          ...(record.kind === "candidate"
            ? ["resumes", "follow-up", "applications"]
            : record.kind === "vacancy"
              ? ["applications"]
              : []),
          ...(record.kind === "application"
            ? ["interviews", "offers", "onboarding"]
            : []),
          ...(record.kind === "onboarding" ? ["checklist"] : []),
          "discussion",
        ].map((item) => (
          <button
            role="tab"
            id={`record-tab-${record.id}-${item}`}
            aria-controls={`record-panel-${record.id}-${item}`}
            tabIndex={tab === item ? 0 : -1}
            aria-selected={tab === item}
            key={item}
            onClick={() => setTab(item)}
          >
            {item === "follow-up"
              ? "My follow-up"
              : item === "resumes"
                ? "CV files"
                : item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div
        role="tabpanel"
        id={`record-panel-${record.id}-${tab}`}
        aria-labelledby={`record-tab-${record.id}-${tab}`}
        tabIndex={0}
        className="record-tab-panel"
      >
        {tab === "details" && (
          <div className="stack">
            <div className="row detail-actions">
              {record.kind === "interview" && data.meetingUrl ? (
                <a
                  className="button"
                  href={String(data.meetingUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open meeting link
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              ) : null}
              {record.kind === "candidate" && (
                <>
                  {data.email ? (
                    <a
                      className="button secondary"
                      href={`mailto:${encodeURIComponent(String(data.email))}`}
                    >
                      <Mail size={16} aria-hidden="true" />
                      Email candidate
                    </a>
                  ) : null}
                  {data.phone ? (
                    <a
                      className="button secondary"
                      href={`tel:${encodeURIComponent(String(data.phone))}`}
                    >
                      <Phone size={16} aria-hidden="true" />
                      Call candidate
                    </a>
                  ) : null}
                  <button
                    className="button"
                    disabled={!canWrite || !!record.archivedAt}
                    onClick={() =>
                      onCreate("applications", { candidateId: record.id })
                    }
                  >
                    <Plus size={16} aria-hidden="true" />
                    Assign to vacancy
                  </button>
                  <button
                    className="button secondary"
                    disabled={!canWrite || !!record.archivedAt}
                    onClick={() =>
                      onCreate(
                        "tasks",
                        { candidateId: record.id },
                        {
                          title: `Recruit ${recordLabel(record)}`,
                          context: recordLabel(record),
                        },
                      )
                    }
                  >
                    <Plus size={16} aria-hidden="true" />
                    Create hire task
                  </button>
                </>
              )}
              {record.kind === "vacancy" && (
                <button
                  className="button"
                  disabled={!canWrite || !!record.archivedAt}
                  onClick={() =>
                    onCreate("applications", { vacancyId: record.id })
                  }
                >
                  <Plus size={16} aria-hidden="true" />
                  Add candidate
                </button>
              )}
              {record.kind === "job-role" && (
                <button
                  className="button"
                  disabled={!canWrite || !!record.archivedAt}
                  onClick={() =>
                    onCreate(
                      "vacancies",
                      { jobRoleId: record.id },
                      {
                        ...data,
                        status: "Draft",
                        openings: 1,
                        requisitionId: "",
                        hiringManager: "",
                        recruiter: "",
                        targetDate: "",
                      },
                    )
                  }
                >
                  <Plus size={16} aria-hidden="true" />
                  Create vacancy from role
                </button>
              )}
              {record.kind === "application" && (
                <>
                  <button
                    className="button secondary"
                    disabled={!canWrite || !!record.archivedAt}
                    onClick={() =>
                      onCreate("interviews", { applicationId: record.id })
                    }
                  >
                    Schedule interview
                  </button>
                  <button
                    className="button secondary"
                    disabled={!canWrite || !!record.archivedAt}
                    onClick={() =>
                      onCreate("offers", { applicationId: record.id })
                    }
                  >
                    Create offer
                  </button>
                  <button
                    className="button secondary"
                    disabled={!canWrite || !!record.archivedAt}
                    onClick={() =>
                      onCreate("onboarding", { applicationId: record.id })
                    }
                  >
                    Plan onboarding
                  </button>
                </>
              )}
              {record.kind === "onboarding" && (
                <button
                  className="button"
                  disabled={!canWrite || !!record.archivedAt}
                  onClick={() =>
                    onCreate("checklist", { onboardingId: record.id })
                  }
                >
                  <Plus size={16} aria-hidden="true" />
                  Add checklist item
                </button>
              )}
            </div>
            <div className="detail-facts">
              {Object.entries(record)
                .filter(
                  ([key, value]) =>
                    key.endsWith("Id") &&
                    key !== "legacyId" &&
                    key !== "privateOwnerId" &&
                    value,
                )
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replace("Id", "").replace(/([A-Z])/g, " $1")}</dt>
                    <dd>
                      <ReferenceLabel
                        resource={
                          key === "candidateId"
                            ? "candidates"
                            : key === "vacancyId"
                              ? "vacancies"
                              : key === "applicationId"
                                ? "applications"
                                : key === "onboardingId"
                                  ? "onboarding"
                                  : key === "jobRoleId"
                                    ? "job-roles"
                                    : key === "bucketId"
                                      ? "buckets"
                                      : "candidates"
                        }
                        id={String(value)}
                      />
                    </dd>
                  </div>
                ))}
              {RESOURCE_CONFIG[resource].fields
                .filter(
                  (field) =>
                    !field.readOnly &&
                    field.key !== "legacyAuthorLabel" &&
                    field.key !== "customValues",
                )
                .map((field) => (
                  <div
                    key={field.key}
                    className={
                      field.type === "textarea" || field.type === "json"
                        ? "full-width"
                        : ""
                    }
                  >
                    <dt>{field.label}</dt>
                    <dd
                      className={
                        field.type === "json"
                          ? "pre-wrap code-input"
                          : "pre-wrap"
                      }
                    >
                      {field.type === "tags" ? (
                        <div className="tag-list">
                          {((data[field.key] as string[]) || []).map((tag) => (
                            <span className="tag" key={tag}>
                              {tag}
                            </span>
                          ))}
                          {!((data[field.key] as string[]) || []).length &&
                            "Not recorded"}
                        </div>
                      ) : (
                        display(data[field.key])
                      )}
                    </dd>
                  </div>
                ))}
            </div>
            {record.kind === "task" && (
              <TaskCustomDetails
                values={data.customValues as Record<string, unknown>}
              />
            )}
            {record.kind === "candidate" && (
              <details className="source-details">
                <summary>Original source information & evidence</summary>
                {["rawSource", "evidence", "sourceReviews"].map((key) => (
                  <div key={key}>
                    <h3>
                      {
                        RESOURCE_CONFIG.candidates.fields.find(
                          (field) => field.key === key,
                        )?.label
                      }
                    </h3>
                    <pre>{display(data[key])}</pre>
                  </div>
                ))}
              </details>
            )}
            <div className="record-metadata">
              <p>
                Added {formatDate(record.createdAt, true)} · Updated{" "}
                {formatDate(record.updatedAt, true)} · Version {record.version}
              </p>
              <p>
                ID: <code>{record.id}</code>
                {record.legacyId && (
                  <>
                    {" "}
                    · Legacy ID: <code>{record.legacyId}</code>
                  </>
                )}
              </p>
            </div>
            {record.kind === "bucket" && !record.archivedAt && (
              <div className="field">
                <ReferencePicker
                  kind="bucket"
                  label="Move tasks to this bucket when archiving"
                  value={archiveDestination}
                  onChange={setArchiveDestination}
                />
              </div>
            )}
            {record.kind !== "comment" && (
              <button
                className="button secondary danger-text"
                disabled={!canWrite || busy}
                onClick={archive}
              >
                <Archive size={16} aria-hidden="true" />
                {busy
                  ? "Saving…"
                  : record.archivedAt
                    ? "Restore record"
                    : "Archive record"}
              </button>
            )}
          </div>
        )}
        {tab === "resumes" && <CandidateCvs candidateId={record.id} />}{" "}
        {tab === "follow-up" && <CandidateFollowup candidateId={record.id} />}{" "}
        {tab === "discussion" && <Discussion recordId={record.id} />}{" "}
        {[
          "applications",
          "interviews",
          "offers",
          "onboarding",
          "checklist",
        ].includes(tab) && (
          <RelatedRecords
            resource={tab as ResourceName}
            parentId={record.id}
            parentKey={
              record.kind === "candidate"
                ? "candidateId"
                : record.kind === "vacancy"
                  ? "vacancyId"
                  : record.kind === "application"
                    ? "applicationId"
                    : "onboardingId"
            }
            focusId={tab === "checklist" ? focusChecklistId : undefined}
            onCreate={onCreate}
          />
        )}
      </div>
    </>
  );
  return inline ? (
    <div className="panel profile-panel">{details}</div>
  ) : (
    <Dialog title={RESOURCE_CONFIG[resource].singular} wide onClose={onClose}>
      <div className="dialog-body stack">{details}</div>
      <footer className="dialog-footer">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
      </footer>
    </Dialog>
  );
}
export function CandidateCvs({ candidateId }: { candidateId: string }) {
  const { team, role } = useWorkspace();
  const [pagination, setPagination] = useState({ candidateId, page: 1 });
  const page = pagination.candidateId === candidateId ? pagination.page : 1;
  const pageSize = 50;
  const result = useApi<{
    data: {
      id: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      status: string;
      sourcePath?: string;
      createdAt: string;
      downloadProtocol: string | null;
    }[];
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  }>(`/api/v1/candidates/${candidateId}/cvs?page=${page}&pageSize=${pageSize}`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const setPage = (next: number) => setPagination({ candidateId, page: next });
  const download = async (cv: {
    id: string;
    downloadProtocol: string | null;
  }) => {
    if (!team) return;
    setBusy(cv.id);
    setError("");
    try {
      if (cv.downloadProtocol === "s3-url-v1") {
        const response = await requestJson<{ url: string }>(
          team.id,
          `/api/v1/cvs/${cv.id}/download`,
        );
        const anchor = document.createElement("a");
        anchor.href = response.url;
        anchor.rel = "noopener noreferrer";
        anchor.target = "_blank";
        anchor.click();
      } else if (cv.downloadProtocol === "blob-chunks-v1") {
        // Bytes and the object URL stay local to this call and never enter React state.
        const file = await downloadVerifiedCv(team.id, cv.id);
        saveCvBytes(file.bytes, file.originalName);
      } else
        throw new Error(
          "This CV uses a download method this page does not support. Refresh the page and try again.",
        );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="stack">
      <div>
        <h3 className="row">
          CV files & versions
          {result.data && (
            <span className="heading-count">
              {result.data.pagination.total.toLocaleString()} file records
            </span>
          )}
        </h3>
        <p className="muted">
          Files stay private. Open CV creates a short-lived, authorized
          download. Original folder paths are retained as source metadata. The
          count includes file records in every upload status.
        </p>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {result.error ? (
        <LoadError message={result.error} retry={result.refresh} />
      ) : result.loading ? (
        <Loading />
      ) : result.data?.data.length ? (
        <div className="cv-list">
          {result.data.data.map((cv) => (
            <article className="cv-file" key={cv.id}>
              <FileText size={25} aria-hidden="true" />
              <div>
                <strong>{cv.originalName}</strong>
                <p className="muted">
                  {(cv.sizeBytes / 1024).toFixed(0)} KB ·{" "}
                  {formatDate(cv.createdAt)} · {cv.status}
                </p>
                {cv.sourcePath && (
                  <details>
                    <summary>Original source location</summary>
                    <code>{cv.sourcePath}</code>
                    <p className="muted small-text">
                      This is the source location recorded during migration. A
                      cloud app cannot open File Explorer on the original
                      computer.
                    </p>
                  </details>
                )}
              </div>
              <button
                className="button secondary"
                disabled={cv.status !== "ready" || busy === cv.id}
                onClick={() => download(cv)}
              >
                <Download size={16} aria-hidden="true" />
                {busy === cv.id ? "Preparing…" : "Open CV"}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={page > 1 ? "No file records on this page" : "No CV files yet"}
          description={
            page > 1
              ? "Return to the first page or refresh the file list."
              : "Upload a CV to keep the document alongside this candidate record."
          }
          action={
            page > 1 ? (
              <button className="button secondary" onClick={() => setPage(1)}>
                Go to first page
              </button>
            ) : undefined
          }
        />
      )}
      {result.data && (
        <nav className="pagination" aria-label="CV file pages">
          <span>
            {result.data.data.length > 0
              ? `Showing ${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, result.data.pagination.total).toLocaleString()} of ${result.data.pagination.total.toLocaleString()} file records`
              : `0 records on this page · ${result.data.pagination.total.toLocaleString()} total file records`}
          </span>
          <div className="row">
            <button
              className="button secondary small"
              disabled={page <= 1 || result.loading}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} of {Math.max(1, result.data.pagination.totalPages)}
            </span>
            <button
              className="button secondary small"
              disabled={
                page >= result.data.pagination.totalPages || result.loading
              }
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </nav>
      )}
      {team && role !== "viewer" && (
        <CvUpload
          teamId={team.id}
          candidateId={candidateId}
          onComplete={() => {
            setPage(1);
            result.refresh();
          }}
        />
      )}
    </div>
  );
}
interface PersonalState {
  version: number;
  shortlisted: boolean;
  status: string;
  note: string;
}
function CandidateFollowup({ candidateId }: { candidateId: string }) {
  const { team, role } = useWorkspace();
  const result = useApi<{ data: PersonalState }>(
    `/api/v1/candidates/${candidateId}/state`,
  );
  const [draft, setDraft] = useState<PersonalState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const current = draft ?? result.data?.data ?? null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !team || saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await requestJson<{ data: PersonalState }>(
        team.id,
        `/api/v1/candidates/${candidateId}/state`,
        {
          method: "PATCH",
          body: JSON.stringify(personalStateMutation(current)),
        },
      );
      setDraft(response.data);
      setDirty(false);
      setSaved(true);
      result.refresh();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setSaving(false);
    }
  };
  if (result.error && !current)
    return <LoadError message={result.error} retry={result.refresh} />;
  if (!current) return <Loading />;
  return (
    <form onSubmit={save}>
      <fieldset
        className="editor-fieldset stack"
        disabled={saving || role === "viewer"}
      >
        <p className="notice">
          These follow-up notes and shortlist choices are private to your
          account. Use Discussion for notes your team should see.
        </p>
        {result.error && (
          <p className="notice error" role="alert">
            The latest follow-up could not be refreshed: {result.error}. Your
            draft is retained.
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="notice success" role="status">
            Your follow-up has been saved.
          </p>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={current.shortlisted}
            onChange={(e) => {
              setDraft({ ...current, shortlisted: e.target.checked });
              setDirty(true);
              setSaved(false);
            }}
          />
          <Star size={17} aria-hidden="true" />
          Add to my shortlist
        </label>
        <div className="field">
          <label htmlFor="followup-status">My follow-up status</label>
          <select
            id="followup-status"
            value={current.status}
            onChange={(e) => {
              setDraft({ ...current, status: e.target.value });
              setDirty(true);
              setSaved(false);
            }}
          >
            {CANDIDATE_STATUSES.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="followup-note">My private notes</label>
          <textarea
            id="followup-note"
            rows={7}
            maxLength={10000}
            value={current.note}
            onChange={(e) => {
              setDraft({ ...current, note: e.target.value });
              setDirty(true);
              setSaved(false);
            }}
          />
        </div>
        <div>
          <button
            className="button"
            disabled={saving || !dirty || role === "viewer"}
          >
            <Check size={16} aria-hidden="true" />
            {saving ? "Saving…" : "Save my follow-up"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function RelatedRecords({
  resource,
  parentId,
  parentKey,
  onCreate,
  focusId,
}: {
  resource: ResourceName;
  parentId: string;
  parentKey: ReferenceField;
  focusId?: string;
  onCreate: (
    resource: ResourceName,
    refs?: Partial<Record<ReferenceField, string>>,
  ) => void;
}) {
  const { team, role } = useWorkspace();
  const [page, setPage] = useState(1);
  const result = useApi<ListResponse>(
    `/api/v1/${resource}?${parentKey}=${parentId}&pageSize=100&page=${page}`,
  );
  const [edit, setEdit] = useState<RecordDto | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<RecordDto | null>(null);
  const [linkedError, setLinkedError] = useState("");
  useEffect(() => {
    let active = true;
    if (team && focusId)
      requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/${resource}/${encodeURIComponent(focusId)}`,
      )
        .then((response) => {
          if (response.data[parentKey] !== parentId)
            throw new Error(
              "This item is not linked to the selected parent record.",
            );
          if (active) {
            setSelectedRecord(response.data);
            setLinkedError("");
          }
        })
        .catch((error: unknown) => {
          if (active) setLinkedError(humanError(error));
        });
    return () => {
      active = false;
    };
  }, [team, resource, focusId, parentKey, parentId]);
  const completed =
    result.data?.data.filter((r) =>
      ["Complete", "Waived"].includes(String(dataOf(r).status)),
    ).length || 0;
  return (
    <div className="stack">
      {linkedError && (
        <p className="notice error" role="alert">
          The linked item could not be opened: {linkedError}
        </p>
      )}
      <div className="row space-between">
        <h3>{RESOURCE_CONFIG[resource].label}</h3>
        <button
          className="button secondary"
          disabled={role === "viewer"}
          onClick={() => onCreate(resource, { [parentKey]: parentId })}
        >
          <Plus size={16} aria-hidden="true" />
          Add {RESOURCE_CONFIG[resource].singular.toLowerCase()}
        </button>
      </div>
      {resource === "checklist" &&
      result.data?.data.length &&
      result.data.pagination.total <= 100 ? (
        <div>
          <div className="row space-between">
            <strong>Checklist progress</strong>
            <span>
              {completed} / {result.data.data.length}
            </span>
          </div>
          <progress
            aria-label="Checklist progress"
            value={completed}
            max={result.data.data.length}
          />
        </div>
      ) : null}
      {result.error ? (
        <LoadError message={result.error} retry={result.refresh} />
      ) : result.loading ? (
        <Loading />
      ) : result.data?.data.length ? (
        <div className="related-list">
          {result.data.data.map((record) => (
            <button
              key={record.id}
              className="related-item"
              onClick={() => setSelectedRecord(record)}
            >
              <span>
                <strong>{recordLabel(record)}</strong>
                <small>
                  {String(dataOf(record).stage || dataOf(record).status || "")}{" "}
                  ·{" "}
                  {formatDate(
                    dataOf(record).dueDate ||
                      dataOf(record).startAt ||
                      record.createdAt,
                  )}
                </small>
              </span>
              <ArrowUpRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">
          No {RESOURCE_CONFIG[resource].label.toLowerCase()} linked yet.
        </p>
      )}
      {result.data && result.data.pagination.total > 100 && (
        <div className="pagination">
          <span>
            {result.data.pagination.total} linked records · page {page} of{" "}
            {result.data.pagination.totalPages}
          </span>
          <div className="row">
            <button
              className="button secondary small"
              disabled={page <= 1}
              onClick={() => setPage((n) => n - 1)}
            >
              Previous
            </button>
            <button
              className="button secondary small"
              disabled={page >= result.data.pagination.totalPages}
              onClick={() => setPage((n) => n + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
      {selectedRecord && (
        <RecordDetail
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          onEdit={() => setEdit(selectedRecord)}
          onCreate={onCreate}
          onRefresh={result.refresh}
          onUpdated={(value) => {
            setSelectedRecord(value);
            result.refresh();
          }}
        />
      )}
      {edit && (
        <RecordEditor
          resource={resource}
          record={edit}
          onClose={() => setEdit(null)}
          onSaved={(value) => {
            setEdit(null);
            setSelectedRecord(value);
            result.refresh();
          }}
        />
      )}
    </div>
  );
}
function Discussion({ recordId }: { recordId: string }) {
  const { team, role } = useWorkspace();
  const result = useApi<ListResponse>(
    `/api/v1/comments?parentRecordId=${recordId}&pageSize=100&sort=createdAt&direction=asc`,
  );
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const key = useRef(new Map<string, string>());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!team || saving) return;
    setSaving(true);
    setError("");
    try {
      let requestKey = key.current.get(body);
      if (!requestKey) {
        requestKey = crypto.randomUUID();
        key.current.set(body, requestKey);
      }
      await requestJson(team.id, "/api/v1/comments", {
        method: "POST",
        headers: { "Idempotency-Key": requestKey },
        body: JSON.stringify({ parentRecordId: recordId, data: { body } }),
      });
      setBody("");
      key.current.clear();
      result.refresh();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="stack">
      <h3>Team discussion</h3>
      <p className="muted">
        Comments are shared with this team and kept as an append-only
        conversation.
      </p>
      {result.error && (
        <p className="notice error" role="alert">
          {result.error}
        </p>
      )}
      {result.data?.data.map((comment) => (
        <article className="comment" key={comment.id}>
          <header>
            <strong>
              {String(dataOf(comment).legacyAuthorLabel || comment.createdBy)}
              {dataOf(comment).legacyAuthorLabel ? " · imported label" : ""}
            </strong>
            <time>{formatDate(comment.createdAt, true)}</time>
          </header>
          <p className="pre-wrap">{String(dataOf(comment).body)}</p>
        </article>
      ))}
      {!result.loading && !result.data?.data.length && (
        <p className="muted">
          Start the conversation with a useful update for your team.
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset className="editor-fieldset stack" disabled={saving}>
          <div className="field">
            <label htmlFor="comment-body">Add a comment</label>
            <textarea
              id="comment-body"
              required
              rows={3}
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div>
            <button
              className="button"
              disabled={saving || !body.trim() || role === "viewer"}
            >
              <MessageSquare size={16} aria-hidden="true" />
              {saving ? "Posting…" : "Post comment"}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
function BulkAssign({
  candidateIds,
  onClose,
  onSaved,
}: {
  candidateIds: string[];
  onClose: () => void;
  onSaved: (counts: { created: number; skipped: number }) => void;
}) {
  const { team } = useWorkspace();
  const [vacancy, setVacancy] = useState("");
  const [stage, setStage] = useState("Sourced");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const idempotency = useRef(new Map<string, string>());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!team || saving) return;
    setSaving(true);
    setError("");
    try {
      const serialized = JSON.stringify({
        candidateIds,
        vacancyId: vacancy,
        stage,
        owner,
      });
      let key = idempotency.current.get(serialized);
      if (!key) {
        key = crypto.randomUUID();
        idempotency.current.set(serialized, key);
      }
      const response = await requestJson<{ created: number; skipped: number }>(
        team.id,
        "/api/v1/applications/bulk",
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: serialized,
        },
      );
      onSaved({ created: response.created, skipped: response.skipped });
    } catch (e) {
      setError(humanError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title="Assign selected candidates" onClose={onClose} busy={saving}>
      <form onSubmit={submit}>
        <fieldset className="editor-fieldset" disabled={saving}>
          <div className="dialog-body stack">
            <p>
              Assign {candidateIds.length} selected candidates to one vacancy.
              Candidates with an existing active application for this vacancy
              will be skipped.
            </p>
            <div className="field">
              <ReferencePicker
                kind="vacancy"
                label="Vacancy"
                value={vacancy}
                onChange={setVacancy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="bulk-stage">Starting stage</label>
              <select
                id="bulk-stage"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                {APPLICATION_STAGES.map((stage) => (
                  <option key={stage}>{stage}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bulk-owner">Owner</label>
              <input
                id="bulk-owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </div>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <button
              className="button secondary"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button" disabled={saving || !vacancy}>
              {saving ? "Assigning…" : "Assign candidates"}
            </button>
          </footer>
        </fieldset>
      </form>
    </Dialog>
  );
}
function WorkflowSettings({ onClose }: { onClose: () => void }) {
  const { role } = useWorkspace();
  const [tab, setTab] = useState<ResourceName>("buckets");
  const result = useApi<ListResponse>(
    `/api/v1/${tab}?pageSize=100&sort=position&includeArchived=true`,
  );
  const [editor, setEditor] = useState<{ record?: RecordDto } | null>(null);
  const [detail, setDetail] = useState<RecordDto | null>(null);
  return (
    <Dialog title="Customize your task workflow" wide onClose={onClose}>
      <div className="dialog-body stack">
        <p className="muted">
          Buckets become task statuses. Custom fields belong to this team&apos;s
          task board. Archive retains existing task values.
        </p>
        <div className="tabs">
          <button
            aria-pressed={tab === "buckets"}
            onClick={() => setTab("buckets")}
          >
            Workflow buckets
          </button>
          <button
            aria-pressed={tab === "task-fields"}
            onClick={() => setTab("task-fields")}
          >
            Custom task fields
          </button>
        </div>
        <div className="row space-between">
          <h3>{RESOURCE_CONFIG[tab].label}</h3>
          <button
            className="button"
            disabled={role === "viewer"}
            onClick={() => setEditor({})}
          >
            <Plus size={16} aria-hidden="true" />
            Add {RESOURCE_CONFIG[tab].singular.toLowerCase()}
          </button>
        </div>
        {result.error && <p className="notice error">{result.error}</p>}
        <div className="related-list">
          {result.data?.data.map((record) => (
            <div className="related-item" key={record.id}>
              <span>
                <strong>{recordLabel(record)}</strong>
                <small>
                  {record.archivedAt
                    ? "Archived"
                    : tab === "task-fields"
                      ? `${dataOf(record).type}${dataOf(record).required ? " · Required" : ""}`
                      : `Position ${dataOf(record).position}`}
                </small>
              </span>
              <div className="row">
                <button
                  className="button secondary small"
                  disabled={role === "viewer"}
                  onClick={() => setEditor({ record })}
                >
                  Edit
                </button>
                <button
                  className="button secondary small"
                  onClick={() => setDetail(record)}
                >
                  Details
                </button>
              </div>
            </div>
          ))}
        </div>
        {!result.loading && !result.data?.data.length && (
          <p className="muted">
            No {RESOURCE_CONFIG[tab].label.toLowerCase()} yet.
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <button className="button secondary" onClick={onClose}>
          Done
        </button>
      </footer>
      {editor && (
        <RecordEditor
          resource={tab}
          record={editor.record}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            result.refresh();
          }}
        />
      )}
      {detail && (
        <RecordDetail
          record={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setEditor({ record: detail });
            setDetail(null);
          }}
          onRefresh={result.refresh}
          onCreate={() => {}}
          onUpdated={setDetail}
        />
      )}
    </Dialog>
  );
}
function SaveView({
  resource,
  query,
  views,
  onClose,
  onSaved,
}: {
  resource: ResourceName;
  query: Record<string, unknown>;
  views: RecordDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { team } = useWorkspace();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [manage, setManage] = useState<RecordDto | null>(null);
  const allViews = useApi<ListResponse>(
    `/api/v1/views?pageSize=100&includeArchived=true&area=${resource === "candidates" ? "directory" : "applications"}`,
  );
  const key = useRef(crypto.randomUUID());
  return (
    <Dialog title="Save this view" onClose={onClose} busy={saving}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!team || saving) return;
          setSaving(true);
          setError("");
          try {
            await requestJson(team.id, "/api/v1/views", {
              method: "POST",
              headers: { "Idempotency-Key": key.current },
              body: JSON.stringify({
                data: {
                  name,
                  area:
                    resource === "candidates" ? "directory" : "applications",
                  query,
                },
              }),
            });
            onSaved();
          } catch (e) {
            setError(humanError(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        <fieldset className="editor-fieldset" disabled={saving}>
          <div className="dialog-body stack">
            <p className="muted">
              Save the current search, filters, order and page size to your
              personal views.
            </p>
            <div className="field">
              <label htmlFor="view-name">View name</label>
              <input
                id="view-name"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {error && <p className="notice error">{error}</p>}
            {(allViews.data?.data.length || views.length) > 0 && (
              <details>
                <summary>Manage existing views</summary>
                {(allViews.data?.data || views).map((view) => (
                  <div className="related-item" key={view.id}>
                    <span>
                      {recordLabel(view)}
                      {view.archivedAt ? " · Archived" : ""}
                    </span>
                    <div className="row">
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setManage(view)}
                      >
                        Rename / edit
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={saving}
                        onClick={async () => {
                          if (!team || saving) return;
                          setSaving(true);
                          setError("");
                          try {
                            await requestJson(
                              team.id,
                              `/api/v1/views/${view.id}`,
                              {
                                method: "PATCH",
                                body: JSON.stringify({
                                  version: view.version,
                                  archived: !view.archivedAt,
                                }),
                              },
                            );
                            allViews.refresh();
                          } catch (e) {
                            setError(humanError(e));
                          } finally {
                            setSaving(false);
                          }
                        }}
                      >
                        {view.archivedAt ? "Restore" : "Archive"}
                      </button>
                    </div>
                  </div>
                ))}
              </details>
            )}
          </div>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="button" disabled={saving}>
              {saving ? "Saving…" : "Save view"}
            </button>
          </footer>
        </fieldset>
      </form>
      {manage && (
        <RecordEditor
          resource="views"
          record={manage}
          onClose={() => setManage(null)}
          onSaved={() => {
            setManage(null);
            onSaved();
          }}
        />
      )}
    </Dialog>
  );
}
