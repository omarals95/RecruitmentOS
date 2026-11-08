import { dubaiToday, type ResourceName } from "@/domain/records";

/**
 * The first-load GET paths of every main tab, built by the same functions the screens use, so the
 * prefetch, the cache keys and the round-trip benchmark all request identical paths.
 */
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
    title: "Vacancies",
    description: "Every vacancy your team manages, from draft to closed.",
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

/** The records screen's server-side query state. */
export interface ListQuery {
  page: number;
  pageSize: number;
  search: string;
  sort: string;
  direction: string;
  archived: boolean;
  status: string;
  reviewStatus: string;
  category: string;
  emirate: string;
  degree: string;
  vacancy: string;
  shortlisted: boolean;
  categories: string[];
  skills: string[];
  certifications: string[];
  education: string;
  minYears: string;
  maxYears: string;
}
export function defaultListQuery(section: string): ListQuery {
  const resource = screenDefinitions[section].resource;
  return {
    page: 1,
    pageSize: 25,
    search: "",
    sort: resource === "candidates" ? "name" : "updatedAt",
    direction: "asc",
    archived: false,
    status: "",
    reviewStatus: "",
    category: "",
    emirate: "",
    degree: "",
    vacancy: "",
    shortlisted: section === "shortlist",
    categories: [],
    skills: [],
    certifications: [],
    education: "",
    minYears: "",
    maxYears: "",
  };
}
export function listSearchParams(
  section: string,
  q: ListQuery,
): URLSearchParams {
  const resource = screenDefinitions[section].resource;
  const p = new URLSearchParams({
    page: String(q.page),
    pageSize: String(q.pageSize),
    search: q.search,
    sort: q.sort,
    direction: q.direction,
  });
  if (q.archived) p.set("includeArchived", "true");
  if (q.status)
    p.set(resource === "applications" ? "stage" : "status", q.status);
  if (q.reviewStatus) p.set("reviewStatus", q.reviewStatus);
  if (q.category) p.set("folderCategory", q.category);
  if (q.emirate) p.set("residenceEmirate", q.emirate);
  if (q.degree) p.set("degreeLevel", q.degree);
  if (q.vacancy) p.set("vacancyId", q.vacancy);
  if (q.shortlisted) p.set("shortlisted", "true");
  if (q.categories.length) p.set("categories", JSON.stringify(q.categories));
  if (q.skills.length) p.set("skills", JSON.stringify(q.skills));
  if (q.certifications.length)
    p.set("certifications", JSON.stringify(q.certifications));
  if (q.education.trim()) p.set("education", q.education.trim());
  if (q.minYears) p.set("minYearsExperience", q.minYears);
  if (q.maxYears) p.set("maxYearsExperience", q.maxYears);
  if (section === "source-review") p.set("needsReview", "true");
  return p;
}
export const listPath = (resource: ResourceName, params: URLSearchParams) =>
  `/api/v1/${resource}?${params}`;
export const BUCKETS_PATH =
  "/api/v1/buckets?pageSize=100&sort=position&direction=asc";
/** Loaded on first use of the skill or certification filter, never with the tab. */
export const CANDIDATE_SUGGESTIONS_PATH = "/api/v1/candidates/suggestions";
export const viewsPath = (resource: ResourceName) =>
  `/api/v1/views?pageSize=100&area=${resource === "candidates" ? "directory" : "applications"}`;
/** The records screen's own GETs: its list, plus buckets for tasks and saved views where they exist. */
export function recordsScreenRequests(
  section: string,
  query: ListQuery = defaultListQuery(section),
): string[] {
  const resource = screenDefinitions[section].resource;
  return [
    listPath(resource, listSearchParams(section, query)),
    ...(resource === "tasks" ? [BUCKETS_PATH] : []),
    ...(resource === "candidates" || resource === "applications"
      ? [viewsPath(resource)]
      : []),
  ];
}

export function calendarDays(
  anchor: string,
  view: "month" | "week" | "day",
): string[] {
  const date = new Date(`${anchor}T12:00:00Z`);
  let start = new Date(date);
  let count = 1;
  if (view === "month") {
    start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 12),
    );
    const weekday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - weekday);
    count = 42;
  }
  if (view === "week") {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    count = 7;
  }
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}
/** One page of the calendar's interview range, Dubai days inclusive. */
export function interviewRangePath(days: string[], page: number): string {
  const end = new Date(`${days[days.length - 1]}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "100",
    startFrom: `${days[0]}T00:00:00+04:00`,
    startTo: `${end.toISOString().slice(0, 10)}T00:00:00+04:00`,
    sort: "createdAt",
  });
  return `/api/v1/interviews?${query}`;
}

export const OVERVIEW_PATH = "/api/v1/overview";
export const NOTIFICATIONS_PATH = "/api/v1/notifications";
/** Offer statistics read the default analytics range. */
export const OFFER_STATS_PATH = "/api/v1/analytics";
export const analyticsPath = (from: string, to: string) =>
  `/api/v1/analytics?from=${from}&to=${to}`;
export const activityPath = (page: number, search: string, kind: string) =>
  `/api/v1/activity?page=${page}&pageSize=50&search=${encodeURIComponent(search)}&kind=${encodeURIComponent(kind)}`;
export const candidateProfileRequests = (id: string) => [
  `/api/v1/candidates/${id}`,
];

/** Every main tab in the shell navigation, except settings, with its first-load GETs. */
export function tabRequests(today = dubaiToday()): Record<string, string[]> {
  return {
    "/app": [OVERVIEW_PATH],
    "/app/candidates": recordsScreenRequests("candidates"),
    "/app/shortlist": recordsScreenRequests("shortlist"),
    "/app/vacancies": recordsScreenRequests("vacancies"),
    "/app/roles": recordsScreenRequests("roles"),
    "/app/pipeline": recordsScreenRequests("pipeline"),
    "/app/tasks": recordsScreenRequests("tasks"),
    "/app/interviews": [interviewRangePath(calendarDays(today, "month"), 1)],
    "/app/offers": [...recordsScreenRequests("offers"), OFFER_STATS_PATH],
    "/app/onboarding": recordsScreenRequests("onboarding"),
    "/app/analytics": [analyticsPath("", "")],
    "/app/insights": [analyticsPath("", ""), OVERVIEW_PATH],
    "/app/source-review": recordsScreenRequests("source-review"),
    "/app/activity": [activityPath(1, "", "")],
    "/app/notifications": [NOTIFICATIONS_PATH],
  };
}

/** The daily tabs prefetched once after sign-in. */
export const PREFETCH_TABS = [
  "/app",
  "/app/candidates",
  "/app/pipeline",
  "/app/tasks",
  "/app/vacancies",
] as const;

/**
 * Fetches each uncached first-load path of the prefetched tabs once, at most `concurrency` at a
 * time. A failed prefetch is ignored; the tab loads normally when opened.
 */
export async function prefetchTabs(
  fetchPath: (path: string) => Promise<unknown>,
  isCached: (path: string) => boolean,
  today = dubaiToday(),
  concurrency = 2,
): Promise<void> {
  const all = tabRequests(today);
  const queue = [...new Set(PREFETCH_TABS.flatMap((tab) => all[tab]))];
  const worker = async () => {
    // A tab opened meanwhile may have cached its paths; check again just before each fetch.
    for (let path = queue.shift(); path; path = queue.shift())
      if (!isCached(path)) await fetchPath(path).catch(() => undefined);
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
