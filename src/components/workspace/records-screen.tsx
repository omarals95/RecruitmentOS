"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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
  REVIEW_STATUSES,
  safeExternalUrl,
  type RecordDto,
  type ResourceName,
  type ReferenceField,
} from "@/domain/records";
import { CvUpload } from "@/components/cv-upload";
import { downloadVerifiedCv, saveCvBytes } from "@/components/cv-transfer";
import { BulkCvImport } from "./bulk-cv-import";
import { DisplayModeToggle, type DisplayMode } from "./display-mode-toggle";
import { Dialog } from "@/components/ui/dialog";
import { RecordEditor, ReferencePicker } from "./editor";
import { OfferStats } from "./metrics";
import {
  activeFilterCount,
  checklistProgress,
  dataOf,
  display,
  exportSummary,
  isFiltered,
  loadAllPages,
  recordLabel,
  referenceText,
  roleDifferences,
  roleSnapshot,
  initials,
  formatDate,
  formatField,
  formatNumber,
  commentAuthor,
  badgeTone,
  saveBlob,
  type ListResponse,
} from "./helpers";
import {
  ClientError,
  dataCache,
  teamRequester,
  useApi,
  useCacheIdentity,
  useCachedQuery,
  useDebounced,
  usePendingKeys,
  useUnsavedWork,
  useWorkspace,
  requestExport,
  requestJson,
  humanError,
} from "./client";
import { moveRecord, saveFollowup, updateRecord } from "./optimistic";
import { startSpeedTimer, useReadyTiming } from "./speed-log";
import type { SpeedTab } from "@/domain/speed";

import { Loading } from "./skeleton";
import {
  BUCKETS_PATH,
  defaultListQuery,
  listPath,
  listSearchParams,
  screenDefinitions,
  viewsPath,
} from "./tab-requests";

export type { ListResponse } from "./helpers";
export { screenDefinitions } from "./tab-requests";
export { Loading } from "./skeleton";
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
/** Most applications the whole-vacancy board loads; above it the board is replaced by a message. */
const BOARD_LIMIT = 1000;
/**
 * Every application matching `query` (no page), kept in the workspace cache: shown at once on
 * return and refreshed in the background. Application writes patch it in place.
 */
function useWholePipeline(query: string | null) {
  const { team } = useWorkspace();
  const teamId = team?.id;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const fetchPage = (page: number) =>
        requestJson<ListResponse>(
          teamId!,
          `/api/v1/applications?${query}&page=${page}&pageSize=100`,
          { signal },
        );
      let loaded = await loadAllPages(fetchPage, BOARD_LIMIT);
      // The pipeline changed between pages; one more pass usually settles it.
      if (!loaded.tooMany && !loaded.complete)
        loaded = await loadAllPages(fetchPage, BOARD_LIMIT);
      return loaded;
    },
    [teamId, query],
  );
  return useCachedQuery<Awaited<ReturnType<typeof loadAllPages>>>(
    query ? `/api/v1/applications?${query}#board` : null,
    load,
  );
}

export function RecordsScreen({ section }: { section: string }) {
  const searchParams = useSearchParams();
  const linkedRecord = searchParams.get("record");
  const linkedChecklist = searchParams.get("checklist");
  const config = screenDefinitions[section];
  const resource = config.resource;
  const { team, role } = useWorkspace();
  const canWrite = !!team && role !== "viewer";
  // The same defaults tab-requests.ts prefetches, so a prefetched list is this screen's first key.
  const [initial] = useState(() => defaultListQuery(section));
  const [search, setSearch] = useState(initial.search);
  const [status, setStatus] = useState(initial.status);
  const [category, setCategory] = useState(initial.category);
  const [categories, setCategories] = useState<string[]>(initial.categories);
  const [skills, setSkills] = useState<string[]>(initial.skills);
  const [certifications, setCertifications] = useState<string[]>(
    initial.certifications,
  );
  const [shortlisted, setShortlisted] = useState(initial.shortlisted);
  const [reviewStatus, setReviewStatus] = useState(initial.reviewStatus);
  const [emirate, setEmirate] = useState(initial.emirate);
  const [degree, setDegree] = useState(initial.degree);
  const [education, setEducation] = useState(initial.education);
  const [minYears, setMinYears] = useState(initial.minYears);
  const [maxYears, setMaxYears] = useState(initial.maxYears);
  const [vacancy, setVacancy] = useState(initial.vacancy);
  const [archived, setArchived] = useState(initial.archived);
  const [sort, setSort] = useState(initial.sort);
  const [direction, setDirection] = useState(initial.direction);
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [mode, setMode] = useState<DisplayMode>(
    resource === "tasks" || resource === "applications"
      ? "board"
      : resource === "vacancies" || resource === "job-roles"
        ? "cards"
        : "table",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const experienceHelpId = useId();
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
  const [conflict, setConflict] = useState<{
    record: RecordDto;
    target: string;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const debounced = useDebounced(search);
  const params = useMemo(
    () =>
      listSearchParams(section, {
        page,
        pageSize,
        search: debounced,
        sort,
        direction,
        archived,
        status,
        reviewStatus,
        category,
        emirate,
        degree,
        vacancy,
        shortlisted,
        categories,
        skills,
        certifications,
        education,
        minYears,
        maxYears,
      }),
    [
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
      section,
      categories,
      skills,
      certifications,
      education,
      minYears,
      maxYears,
      shortlisted,
      reviewStatus,
    ],
  );
  const result = useApi<ListResponse>(listPath(resource, params));
  // The interviews tab is timed by its calendar, which shows this list only on request.
  useReadyTiming(
    section === "interviews" ? null : `tab.${section as SpeedTab}`,
    !!result.data,
  );
  // With a vacancy selected, the application board covers the whole pipeline in a stable order.
  const boardQuery = useMemo(() => {
    if (resource !== "applications" || mode !== "board" || !vacancy)
      return null;
    const query = new URLSearchParams(params);
    query.delete("page");
    query.delete("pageSize");
    query.set("sort", "createdAt");
    query.set("direction", "asc");
    return query.toString();
  }, [resource, mode, vacancy, params]);
  const board = useWholePipeline(boardQuery);
  const buckets = useApi<ListResponse>(
    resource === "tasks" ? BUCKETS_PATH : null,
  );
  const views = useApi<ListResponse>(
    resource === "candidates" || resource === "applications"
      ? viewsPath(resource)
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
    certifications,
    education,
    minYears,
    maxYears,
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
  // A background revalidation: the current records stay on screen while it runs.
  const refresh = () => {
    result.refresh();
    board.refresh();
    buckets.refresh();
    views.refresh();
    setSelected([]);
  };
  const saved = (record: RecordDto) => {
    const edited = !!editor?.record;
    setEditor(null);
    setNotice(
      `${RESOURCE_CONFIG[kindToResource[record.kind]].singular} saved.`,
    );
    if (detail?.id === record.id) setDetail(record);
    // An edit is already patched into every cached copy; a create still refreshes the lists.
    if (!edited) refresh();
  };
  const move = (record: RecordDto, value: string) => {
    if (!team || (resource !== "tasks" && resource !== "applications")) return;
    if (
      value ===
      (resource === "tasks" ? record.bucketId : String(dataOf(record).stage))
    )
      return;
    setError("");
    setNotice("");
    setConflict(null);
    const saved = startSpeedTimer(
      resource === "tasks" ? "task.move" : "application.stage",
    );
    // The card moves at once; a failed save puts it back and rereads only this record.
    void moveRecord(dataCache, teamRequester(team.id), {
      teamId: team.id,
      resource,
      record,
      target: value,
      label: `Moving ${recordLabel(record)} to ${moveTargetName(value)}`,
    }).then((outcome) => {
      if (outcome.ok) saved();
      if (outcome.ok)
        setNotice(
          resource === "tasks" ? "Task moved." : "Application stage updated.",
        );
      else if (outcome.conflict) setConflict({ record, target: value });
      else if (outcome.message) setError(outcome.message);
    });
  };
  const moveAgain = async () => {
    if (!team || !conflict) return;
    const { record, target } = conflict;
    setConflict(null);
    setError("");
    try {
      // Never reuse the stale version; fetch the current one first.
      const latest = await requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/${resource}/${record.id}`,
      );
      move(latest.data, target);
    } catch (e) {
      setError(humanError(e));
    }
  };
  const moveTargetName = (target: string) => {
    if (resource !== "tasks") return target;
    const bucket = buckets.data?.data.find((item) => item.id === target);
    return bucket ? recordLabel(bucket) : "the chosen bucket";
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
        q.education ||
        q.minYearsExperience !== undefined ||
        q.maxYearsExperience !== undefined ||
        (Array.isArray(q.categories) && q.categories.length) ||
        (Array.isArray(q.skills) && q.skills.length) ||
        (Array.isArray(q.certifications) && q.certifications.length))
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
    setCertifications(
      Array.isArray(q.certifications) ? q.certifications.map(String) : [],
    );
    setShortlisted(q.shortlisted === true || section === "shortlist");
    // Source review already shows only records that need review.
    setReviewStatus(
      section === "source-review" ? "" : String(q.reviewStatus || ""),
    );
    setEmirate(String(q.emirate || ""));
    setDegree(String(q.degreeLevel || ""));
    setEducation(String(q.education || ""));
    setMinYears(
      typeof q.minYearsExperience === "number"
        ? String(q.minYearsExperience)
        : "",
    );
    setMaxYears(
      typeof q.maxYearsExperience === "number"
        ? String(q.maxYearsExperience)
        : "",
    );
    setStatus(String(q.stage || q.status || ""));
    setVacancy(String(q.vacancyId || ""));
    setArchived(!!q.includeArchived);
    setSort(String(q.sort || "updatedAt"));
    setDirection(String(q.direction || "asc"));
    setPageSize(Number(q.pageSize) || 25);
  };
  const filters = {
    status,
    category,
    categories,
    skills,
    certifications,
    shortlisted,
    reviewStatus,
    emirate,
    degree,
    education,
    minYears,
    maxYears,
    vacancy,
    archived,
  };
  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setCategory("");
    setCategories([]);
    setSkills([]);
    setCertifications([]);
    setReviewStatus("");
    setShortlisted(section === "shortlist");
    setEmirate("");
    setDegree("");
    setEducation("");
    setMinYears("");
    setMaxYears("");
    setVacancy("");
    setArchived(false);
  };
  const exportAll = async () => {
    if (!team) return;
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const query = new URLSearchParams(params);
      query.delete("page");
      query.delete("pageSize");
      const file = await requestExport(
        team.id,
        `/api/v1/${resource}/export?${query}`,
      );
      saveBlob(file.filename, file.blob);
      setNotice(exportSummary(file.rows, file.rows).notice);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setExporting(false);
    }
  };
  const columns =
    tableColumns[resource] ||
    RESOURCE_CONFIG[resource].fields.slice(0, 5).map((field) => field.key);
  const columnField = (key: string) =>
    RESOURCE_CONFIG[resource].fields.find((f) => f.key === key);
  const columnLabel = (key: string) => columnField(key)?.label || key;
  const cellText = (key: string, record: RecordDto) =>
    formatField(columnField(key) || { key, type: "text" }, dataOf(record));
  const filterCount = activeFilterCount(filters, section === "shortlist");
  const filtered = isFiltered(search, filters, section === "shortlist");
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
                {formatNumber(result.data.pagination.total)}
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
      {conflict && (
        <div className="notice error" role="alert">
          {recordLabel(conflict.record)} was changed by someone else, so your
          move to {moveTargetName(conflict.target)} was not saved and has been
          undone. The board now shows the latest version.
          <div className="row">
            <button
              className="button small"
              disabled={!canWrite}
              onClick={moveAgain}
            >
              Move to {moveTargetName(conflict.target)} again
            </button>
            <button
              className="button secondary small"
              onClick={() => setConflict(null)}
            >
              Dismiss
            </button>
          </div>
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
            <DisplayModeToggle
              board={resource === "applications" || resource === "tasks"}
              mode={mode}
              onChange={setMode}
            />
            <button
              className="icon-button"
              aria-label="Refresh records"
              onClick={refresh}
            >
              <RefreshCw size={17} />
            </button>
            <button
              className="button secondary filters-toggle"
              aria-expanded={filtersOpen}
              aria-controls={filtersId}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Filter size={16} aria-hidden="true" />
              {filterCount > 0 ? `Filters (${filterCount})` : "Filters"}
            </button>
          </div>
        </div>
        <div
          className={`filter-bar${filtersOpen ? " is-open" : ""}`}
          id={filtersId}
        >
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
              <FilterTags
                label="All of these certifications"
                values={certifications}
                onChange={setCertifications}
              />
              <label>
                Education contains
                <input
                  value={education}
                  maxLength={300}
                  placeholder="Degree, major or university"
                  onChange={(e) => setEducation(e.target.value)}
                />
              </label>
              <label>
                Minimum stated experience (years)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minYears}
                  aria-describedby={
                    minYears || maxYears ? experienceHelpId : undefined
                  }
                  onChange={(e) => setMinYears(e.target.value)}
                />
              </label>
              <label>
                Maximum stated experience (years)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={maxYears}
                  aria-describedby={
                    minYears || maxYears ? experienceHelpId : undefined
                  }
                  onChange={(e) => setMaxYears(e.target.value)}
                />
              </label>
              {(minYears || maxYears) && (
                <p className="muted small-text" id={experienceHelpId}>
                  Candidates without stated experience are not included.
                </p>
              )}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={shortlisted}
                  disabled={section === "shortlist"}
                  onChange={(e) => setShortlisted(e.target.checked)}
                />
                My shortlist only
              </label>
              {section !== "source-review" && (
                <label>
                  Review status
                  <select
                    value={reviewStatus}
                    onChange={(e) => setReviewStatus(e.target.value)}
                  >
                    <option value="">Any review status</option>
                    {REVIEW_STATUSES.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
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
          {filtered && (
            <button className="text-link" onClick={clearFilters}>
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
        ) : !result.data ||
          !(boardQuery
            ? result.data.pagination.total
            : result.data.data.length) ? (
          <EmptyState
            title={
              filtered
                ? "No records match these filters"
                : section === "shortlist"
                  ? "Your shortlist is ready for a first candidate"
                  : section === "source-review"
                    ? "Nothing needs source review"
                    : `Your ${config.title.toLowerCase()} start here`
            }
            description={
              filtered
                ? "Try a broader search or clear your filters."
                : section === "shortlist"
                  ? "Open a candidate profile and select “Add to my shortlist”."
                  : section === "source-review"
                    ? "Every candidate's source information has been reviewed."
                    : `Add your first ${RESOURCE_CONFIG[resource].singular.toLowerCase()} to get started.`
            }
            action={
              filtered ? (
                <button className="button secondary" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : section === "source-review" ? undefined : section ===
                "shortlist" ? (
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
        ) : boardQuery ? (
          board.error ? (
            <LoadError message={board.error} retry={board.refresh} />
          ) : !board.data ? (
            <Loading />
          ) : board.data.tooMany ? (
            <div className="notice" role="status">
              <p>
                This vacancy has {formatNumber(board.data.total)} matching
                applications, more than the board shows at once (1,000). Use the
                table or narrow the filters.
              </p>
              <button
                className="button secondary small"
                onClick={() => setMode("table")}
              >
                Show as table
              </button>
            </div>
          ) : (
            <>
              {!board.data.complete && (
                <p className="notice" role="status">
                  The pipeline changed while it loaded. Refresh to see every
                  application.
                </p>
              )}
              <Kanban
                resource={resource}
                records={board.data.rows}
                buckets={[]}
                onOpen={setDetail}
                onMove={move}
                canWrite={canWrite}
                emptyText="No matching applications"
              />
            </>
          )
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
                    <th key={key}>{columnLabel(key)}</th>
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
                      <td data-label="Select">
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
                        <td data-label="Candidate">
                          <ReferenceLabel
                            resource="candidates"
                            id={record.candidateId}
                          />
                        </td>
                        <td data-label="Vacancy">
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
                      <td data-label="Application">
                        <ReferenceLabel
                          resource="applications"
                          id={record.applicationId}
                        />
                      </td>
                    )}
                    {resource === "onboarding" && (
                      <td data-label="Checklist progress">
                        <OnboardingProgress id={record.id} />
                      </td>
                    )}
                    {columns.map((key, index) => (
                      <td key={key} data-label={columnLabel(key)}>
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
                              <strong>{cellText(key, record)}</strong>
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
                        ) : (
                          cellText(key, record)
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
        {result.data && boardQuery ? (
          <div className="pagination">
            <span className="muted">
              {board.data && !board.data.tooMany
                ? `${formatNumber(board.data.rows.length)} matching applications${board.data.complete ? " · board shows all of them" : ""}`
                : `${formatNumber(board.data?.total ?? result.data.pagination.total)} matching applications`}
            </span>
          </div>
        ) : result.data ? (
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
                {formatNumber(result.data.pagination.total)} matching records
                {mode === "board"
                  ? resource === "applications"
                    ? " · board shows this page; choose a vacancy to see its whole pipeline"
                    : " · board shows this page"
                  : ""}
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
        ) : null}
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
          onUpdated={setDetail}
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
            certifications,
            shortlisted,
            emirate,
            degreeLevel: degree,
            education,
            minYearsExperience: minYears === "" ? undefined : Number(minYears),
            maxYearsExperience: maxYears === "" ? undefined : Number(maxYears),
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
  const { canCreateTeam } = useWorkspace();
  return (
    <section className="panel">
      <EmptyState
        title="A workspace for your team"
        description={
          canCreateTeam
            ? "Create your first team or accept an invitation to start managing recruitment."
            : "You have not joined a team yet. Accept the email invitation from your team owner."
        }
        action={
          canCreateTeam ? (
            <Link className="button" href="/app/settings/team">
              <Users size={17} aria-hidden="true" />
              Create or join a team
            </Link>
          ) : undefined
        }
      />
    </section>
  );
}
export function RecordCard({
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
  emptyText = "No records on this page",
}: {
  resource: ResourceName;
  records: RecordDto[];
  buckets: RecordDto[];
  onOpen: (r: RecordDto) => void;
  onMove: (r: RecordDto, value: string) => void;
  canWrite: boolean;
  emptyText?: string;
}) {
  // A card whose move is still saving cannot be moved again with a stale version.
  const pending = usePendingKeys();
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
              if (record && canWrite && !pending.has(record.id))
                onMove(record, column.id);
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
                  draggable={
                    canWrite && !record.archivedAt && !pending.has(record.id)
                  }
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
                        disabled={
                          !canWrite ||
                          !!record.archivedAt ||
                          pending.has(record.id)
                        }
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
              {!cards.length && <p className="board-empty">{emptyText}</p>}
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
  const label = referenceText({
    data: result.data?.data ?? null,
    loading: result.loading,
    status: result.status,
  });
  if (plain || resource !== "candidates" || !result.data)
    return <span>{label}</span>;
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
  const { done, total } = checklistProgress(result.data?.data || []);
  if (!total) return <small className="muted">Checklist not configured</small>;
  if ((result.data?.pagination.total || 0) > 100)
    return (
      <small className="muted">
        {result.data!.pagination.total} items · open checklist for details
      </small>
    );
  return (
    <div className="onboarding-progress">
      <span>
        {done} / {total} complete or waived
      </span>
      <progress aria-label="Checklist progress" value={done} max={total} />
    </div>
  );
}
const customFieldTypes: Record<string, string> = {
  Date: "date",
  Number: "number",
};
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
                  : formatField(
                      {
                        key,
                        type:
                          (field &&
                            customFieldTypes[String(dataOf(field).type)]) ||
                          "text",
                      },
                      values,
                    )}
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
  const busy = usePendingKeys().has(record.id);
  const [archiveDestination, setArchiveDestination] = useState("");
  const [roleReview, setRoleReview] = useState(false);
  const canWrite = role !== "viewer";
  const resource = kindToResource[record.kind];
  const data = dataOf(record);
  // The write schema allows only http(s), but a stored value is rechecked before it becomes a link.
  const meetingUrl = safeExternalUrl(data.meetingUrl);
  const archive = () => {
    if (!team || busy) return;
    setError("");
    const archived = !record.archivedAt;
    void updateRecord(dataCache, teamRequester(team.id), {
      teamId: team.id,
      resource,
      record,
      next: {
        ...record,
        archivedAt: archived ? new Date().toISOString() : null,
      },
      body: {
        version: record.version,
        archived,
        ...(record.kind === "bucket" && archiveDestination
          ? { moveToBucketId: archiveDestination }
          : {}),
      },
      label: `${archived ? "Archiving" : "Restoring"} ${recordLabel(record)}`,
      local: (value) => {
        if (value) onUpdated(value);
      },
    }).then((outcome) => {
      if (!outcome.ok) setError(outcome.message);
      // Archiving a bucket also moves its tasks on the server.
      else if (record.kind === "bucket") onRefresh();
    });
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
            ? [
                "resumes",
                "follow-up",
                "applications",
                "tasks",
                "interviews",
                "offers",
                "onboarding",
              ]
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
              {record.kind === "interview" && meetingUrl ? (
                <a
                  className="button"
                  href={meetingUrl}
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
              {record.kind === "vacancy" && record.jobRoleId && (
                <button
                  className="button secondary"
                  disabled={!canWrite || !!record.archivedAt}
                  onClick={() => setRoleReview(true)}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Review changes from role
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
                        ...roleSnapshot(data),
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
                        formatField(field, data)
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
          "tasks",
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
            {...(record.kind === "candidate" &&
            ["interviews", "offers", "onboarding"].includes(tab)
              ? {
                  queryKey: "applicationCandidateId",
                  addNote:
                    "Add these from one of the candidate's applications.",
                }
              : {})}
          />
        )}
      </div>
      {roleReview && (
        <RoleRefresh
          vacancy={record}
          onClose={() => setRoleReview(false)}
          onUpdated={(value) => {
            setRoleReview(false);
            onUpdated(value);
          }}
        />
      )}
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
/** Lists the role facts that now differ from the vacancy; only ticked fields are copied. */
function RoleRefresh({
  vacancy,
  onClose,
  onUpdated,
}: {
  vacancy: RecordDto;
  onClose: () => void;
  onUpdated: (record: RecordDto) => void;
}) {
  const { team } = useWorkspace();
  const [current, setCurrent] = useState(vacancy);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const role = useApi<{ data: RecordDto }>(
    `/api/v1/job-roles/${vacancy.jobRoleId}`,
  );
  const differences = role.data
    ? roleDifferences(dataOf(current), dataOf(role.data.data))
    : [];
  const apply = async () => {
    if (!team || !role.data || saving) return;
    setSaving(true);
    setError("");
    const snapshot = roleSnapshot(dataOf(role.data.data));
    try {
      const response = await requestJson<{ data: RecordDto }>(
        team.id,
        `/api/v1/vacancies/${current.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            version: current.version,
            data: Object.fromEntries(
              selected.map((key) => [
                key,
                snapshot[key as keyof typeof snapshot],
              ]),
            ),
          }),
        },
      );
      onUpdated(response.data);
    } catch (e) {
      setError(humanError(e));
      if (e instanceof ClientError && e.status === 409) {
        // Compare again against the latest vacancy and role.
        setSelected([]);
        role.refresh();
        try {
          const latest = await requestJson<{ data: RecordDto }>(
            team.id,
            `/api/v1/vacancies/${current.id}`,
          );
          setCurrent(latest.data);
        } catch (reload) {
          setError(humanError(reload));
        }
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title="Review changes from role"
      wide
      onClose={onClose}
      busy={saving}
    >
      <div className="dialog-body stack">
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {role.error ? (
          <LoadError message={role.error} retry={role.refresh} />
        ) : !role.data ? (
          <Loading />
        ) : role.data.data.archivedAt ? (
          <p className="notice">
            The source role is archived. Its details can no longer be copied.
          </p>
        ) : !differences.length ? (
          <p className="notice">This vacancy already matches its role.</p>
        ) : (
          <fieldset className="editor-fieldset stack" disabled={saving}>
            <legend>
              These role details differ from {recordLabel(current)}. Tick the
              ones to copy into the vacancy; nothing else changes.
            </legend>
            {differences.map((item) => (
              <label className="checkbox-label role-difference" key={item.key}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.key)}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, item.key]
                        : old.filter((key) => key !== item.key),
                    )
                  }
                />
                <span>
                  <strong>{item.label}</strong>
                  <small>Vacancy now: {display(item.vacancy)}</small>
                  <small>Role now: {display(item.role)}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <footer className="dialog-footer">
        <button
          className="button secondary"
          disabled={saving}
          onClick={onClose}
        >
          Cancel
        </button>
        {role.data && !role.data.data.archivedAt && differences.length > 0 && (
          <button
            className="button"
            disabled={saving || !selected.length}
            onClick={apply}
          >
            {saving ? "Applying…" : "Apply selected changes"}
          </button>
        )}
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
  const canUpload = Boolean(team) && role !== "viewer";
  // Environment-only readiness; a failed check keeps the controls and the server still refuses.
  const capability = useApi<{ data: { storageConfigured: boolean } }>(
    canUpload ? "/api/v1/cvs/bulk-capabilities" : null,
  );
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
              {formatNumber(result.data.pagination.total)} file records
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
              ? `Showing ${formatNumber((page - 1) * pageSize + 1)}–${formatNumber(Math.min(page * pageSize, result.data.pagination.total))} of ${formatNumber(result.data.pagination.total)} file records`
              : `0 records on this page · ${formatNumber(result.data.pagination.total)} total file records`}
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
      {team && canUpload && !capability.loading && (
        <CvUpload
          teamId={team.id}
          candidateId={candidateId}
          storageConfigured={capability.data?.data.storageConfigured !== false}
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
  const identity = useCacheIdentity();
  const path = `/api/v1/candidates/${candidateId}/state`;
  const result = useApi<{ data: PersonalState }>(path);
  const [draft, setDraft] = useState<PersonalState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const saving = usePendingKeys().has(path);
  const [saved, setSaved] = useState(false);
  useUnsavedWork(dirty);
  const current = draft ?? result.data?.data ?? null;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !team || !identity || saving) return;
    setError("");
    // Shown as saved at once; on failure the draft stays, marked unsaved, with the reason.
    void saveFollowup(dataCache, teamRequester(team.id), {
      identity,
      candidateId,
      draft: current,
      form: (state) => {
        setDraft(state.draft);
        setDirty(state.dirty);
        setSaved(!state.dirty);
      },
    }).then((outcome) => {
      if (!outcome.ok && outcome.message) setError(outcome.message);
    });
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
  queryKey = parentKey,
  addNote,
  onCreate,
  focusId,
}: {
  resource: ResourceName;
  parentId: string;
  parentKey: ReferenceField;
  /** The list filter naming the parent; defaults to parentKey. */
  queryKey?: string;
  /** Shown instead of the Add button, for records that cannot be added from this parent. */
  addNote?: string;
  focusId?: string;
  onCreate: (
    resource: ResourceName,
    refs?: Partial<Record<ReferenceField, string>>,
  ) => void;
}) {
  const { team, role } = useWorkspace();
  const [page, setPage] = useState(1);
  const result = useApi<ListResponse>(
    `/api/v1/${resource}?${queryKey}=${parentId}&pageSize=100&page=${page}`,
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
  const progress = checklistProgress(result.data?.data || []);
  return (
    <div className="stack">
      {linkedError && (
        <p className="notice error" role="alert">
          The linked item could not be opened: {linkedError}
        </p>
      )}
      <div className="row space-between">
        <h3>{RESOURCE_CONFIG[resource].label}</h3>
        {addNote ? (
          <p className="muted">{addNote}</p>
        ) : (
          <button
            className="button secondary"
            disabled={role === "viewer"}
            onClick={() => onCreate(resource, { [parentKey]: parentId })}
          >
            <Plus size={16} aria-hidden="true" />
            Add {RESOURCE_CONFIG[resource].singular.toLowerCase()}
          </button>
        )}
      </div>
      {resource === "checklist" &&
      result.data &&
      result.data.pagination.total <= 100 ? (
        progress.total ? (
          <div>
            <div className="row space-between">
              <strong>Checklist progress</strong>
              <span>
                {progress.done} / {progress.total}
              </span>
            </div>
            <progress
              aria-label="Checklist progress"
              value={progress.done}
              max={progress.total}
            />
          </div>
        ) : (
          <p className="muted">Checklist not configured</p>
        )
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
                {queryKey === "applicationCandidateId" &&
                  (resource === "interviews" || resource === "offers") && (
                    <small>
                      For{" "}
                      <ReferenceLabel
                        resource="applications"
                        id={record.applicationId}
                        plain
                      />
                    </small>
                  )}
                {resource === "tasks" ? (
                  <small>
                    {String(dataOf(record).priority)} ·{" "}
                    {dataOf(record).dueDate
                      ? `Due ${formatDate(dataOf(record).dueDate)}`
                      : "No due date"}
                  </small>
                ) : (
                  <small>
                    {String(
                      dataOf(record).stage || dataOf(record).status || "",
                    )}{" "}
                    ·{" "}
                    {formatDate(
                      dataOf(record).dueDate ||
                        dataOf(record).startAt ||
                        record.createdAt,
                    )}
                  </small>
                )}
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
          onUpdated={setSelectedRecord}
        />
      )}
      {edit && (
        <RecordEditor
          resource={resource}
          record={edit}
          onClose={() => setEdit(null)}
          onSaved={(value) => {
            // The saved record is already patched into this list.
            setEdit(null);
            setSelectedRecord(value);
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
  useUnsavedWork(body !== "");
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
            <strong>{commentAuthor(comment)}</strong>
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
                      : `Position ${dataOf(record).position}${dataOf(record).completed ? " · Counts as completed" : ""}`}
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
  const pending = usePendingKeys();
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
                        disabled={saving || pending.has(view.id)}
                        onClick={() => {
                          if (!team || saving) return;
                          setError("");
                          const archived = !view.archivedAt;
                          void updateRecord(dataCache, teamRequester(team.id), {
                            teamId: team.id,
                            resource: "views",
                            record: view,
                            next: {
                              ...view,
                              archivedAt: archived
                                ? new Date().toISOString()
                                : null,
                            },
                            body: { version: view.version, archived },
                            label: `${archived ? "Archiving" : "Restoring"} ${recordLabel(view)}`,
                          }).then((outcome) => {
                            if (!outcome.ok) setError(outcome.message);
                          });
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
