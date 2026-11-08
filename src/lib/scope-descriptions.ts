import type { Scope } from "./permissions";
import type { McpScope } from "./permissions";

export const scopeDescriptions: Record<Scope, string> = {
  "candidates:read": "Read candidate facts",
  "candidates:write": "Create and edit candidates",
  "recruitment:read": "Read jobs, pipeline and tasks",
  "recruitment:write": "Manage recruitment records",
  "cvs:read":
    "Read CVs and private download links (also needs candidates:read)",
  "cvs:write": "Upload CVs",
  "imports:write": "Import legacy identifiers and source evidence",
};

/** What each scope lets an MCP client do through the MCP tools, shown on the consent page. */
export const mcpScopeDescriptions: Record<McpScope, string> = {
  "candidates:read":
    "Search candidates and read their stated facts and evidence summaries",
  "recruitment:read":
    "Read job roles, vacancies, applications, tasks, interviews, offers and onboarding",
  "cvs:read": "See CV file names, types and sizes, but not CV contents",
  "candidates:write": "Add new candidates",
  "recruitment:write":
    "Create, update, archive and restore job roles, vacancies, applications, interviews, offers and onboarding, move application stages and add comments; comments on candidates also need candidates:read and candidates:write",
};
