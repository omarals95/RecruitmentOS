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
    "Search candidates, read their stated facts and evidence summaries, check possible duplicates, and read your own shortlist, follow-up status and private notes",
  "recruitment:read":
    "Read job roles, vacancies, applications, interviews, offers, onboarding, tasks, comments, record history, dashboard numbers, and your own reminders and saved views",
  "cvs:read":
    "Read the text of your team's CVs, which shares CV contents with this app, and see CV file names, types and sizes (also needs candidate access)",
  "candidates:write":
    "Add and edit candidates' stated facts, archive and restore candidates, and set your own shortlist, follow-up status and private notes",
  "recruitment:write":
    "Create, update, archive and restore recruitment records and tasks, move application stages and tasks, add comments, add and rename task buckets and fields, save views and mark reminders read; candidate comments and archives also need candidate permissions",
  "cvs:write": "Upload CVs and start bulk imports",
};
