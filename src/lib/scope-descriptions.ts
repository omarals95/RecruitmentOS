import type { Scope } from "./permissions";

export const scopeDescriptions: Record<Scope, string> = {
  "candidates:read": "Read candidate facts",
  "candidates:write": "Create and edit candidates",
  "recruitment:read": "Read jobs, pipeline and tasks",
  "recruitment:write": "Manage recruitment records",
  "cvs:read": "Read CVs and private download links",
  "cvs:write": "Upload CVs",
  "imports:write": "Import legacy identifiers and source evidence",
};
