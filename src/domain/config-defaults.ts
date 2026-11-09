import { roleScopes, type Role } from "../lib/permissions";
import {
  ACTIONS,
  PAGE_KEYS,
  READ_ACTIONS,
  RECORD_RESOURCES,
  type Action,
  type ActionResource,
  type FieldRule,
  type RoleBody,
} from "./config";
import { recordDataSchemas } from "./records";

/** A built-in configuration object: version 1 with a fixed, well-known version id (§2.1). */
export type RoleTemplate = {
  key: string;
  versionId: string;
  version: 1;
  body: RoleBody;
};

const RECORD_WRITES = ACTIONS.filter(
  (action) =>
    !(READ_ACTIONS as readonly Action[]).includes(action) &&
    !["erase", "import", "admin"].includes(action),
);
const everyGroup = (scope: RoleBody["recordScope"]["pipeline"]) => ({
  pipeline: scope,
  candidates: scope,
  tasks: scope,
});

// Today's effect of each team role: its scopes, every page and field, record scope all. Imports
// are allowed on every record resource, as importPermission() is; erasure, two-step reset and team
// creation stay owner-only and storage settings owner-or-admin, in code and mirrored here.
function todaysRole(membership: Role, name: string): RoleBody {
  const writes = membership !== "viewer";
  const manager = membership === "owner" || membership === "admin";
  const actions: Partial<Record<ActionResource, Action[]>> = {};
  for (const resource of RECORD_RESOURCES)
    actions[resource] = [
      ...READ_ACTIONS,
      ...(writes ? RECORD_WRITES : []),
      ...(manager ? (["import"] as const) : []),
      ...(membership === "owner" && resource === "candidates"
        ? (["erase"] as const)
        : []),
    ];
  if (manager) {
    actions.directory = ["view", "create", "edit", "archive"];
    actions["storage-settings"] = ["admin"];
  }
  if (membership === "owner") {
    actions["two-step-reset"] = ["admin"];
    actions.teams = ["admin"];
  }
  return {
    name,
    membership,
    scopes: roleScopes(membership),
    pages: [...PAGE_KEYS],
    actions,
    fields: {},
    recordScope: everyGroup("all"),
  };
}

// Templates are shared by every context of the process, so no caller can widen one in place.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const template = (key: string, id: number, body: RoleBody): RoleTemplate =>
  deepFreeze({
    key,
    versionId: `00000000-0000-4000-8000-000000000${id}`,
    version: 1,
    body,
  });

export const OWNER_ROLE = template("owner", 101, todaysRole("owner", "Owner"));
export const ADMIN_ROLE = template("admin", 102, todaysRole("admin", "Admin"));
export const RECRUITER_ROLE = template(
  "recruiter",
  103,
  todaysRole("recruiter", "Recruiter"),
);
export const VIEWER_ROLE = template(
  "viewer",
  104,
  todaysRole("viewer", "Viewer"),
);

/** Assigned to nobody until R2a-10; record scope is not enforced until R2a-18. */
export const HIRING_MANAGER_ROLE = template("hiring-manager", 105, {
  name: "Hiring manager",
  membership: "recruiter",
  scopes: roleScopes("recruiter"),
  pages: ["home", "vacancies", "applications", "interviews", "approvals"],
  actions: {
    candidates: ["view", "comment"],
    "job-roles": ["view"],
    vacancies: ["view", "edit", "transition", "comment"],
    applications: ["view", "create", "edit", "transition", "comment"],
    interviews: ["view", "create", "edit", "comment"],
    offers: ["view", "approve"],
    comments: ["view", "create"],
  },
  fields: {
    offer: { amount: "hidden-unless-approver" },
    candidate: {
      email: "read",
      phone: "read",
      explicitGender: "hidden",
      nationalServiceStatus: "hidden",
    },
  },
  recordScope: everyGroup("unit"),
});

/** Sees only the candidate's name and job title; the CV comes from cvs:read in the viewer ceiling. */
export const INTERVIEWER_ROLE = template("interviewer", 106, {
  name: "Interviewer",
  membership: "viewer",
  scopes: roleScopes("viewer"),
  pages: ["home", "interviews"],
  actions: { interviews: ["view"], candidates: ["view"] },
  fields: {
    candidate: Object.fromEntries(
      Object.keys(recordDataSchemas.candidate.shape)
        .filter((key) => key !== "name" && key !== "jobTitle")
        .map((key) => [key, "hidden" satisfies FieldRule]),
    ),
  },
  recordScope: everyGroup("assigned"),
});

export const ROLE_TEMPLATES = [
  OWNER_ROLE,
  ADMIN_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
] as const;

const BUILT_IN_ROLES: Record<Role, RoleTemplate> = {
  owner: OWNER_ROLE,
  admin: ADMIN_ROLE,
  recruiter: RECRUITER_ROLE,
  viewer: VIEWER_ROLE,
};
/** The template a member holds today, by member.role. */
export function builtInRoleFor(role: Role): RoleTemplate {
  return BUILT_IN_ROLES[role];
}
