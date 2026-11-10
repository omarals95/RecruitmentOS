# Admin portal: design reference

_Added by R2-ADM-00 (job 065), 10 November 2026. Design and reference material only._

## What this folder is

This folder holds the design reference for the RecruitmentOS **Admin portal**, the one place for all administration at `/app/admin`. It is never served by the app and never imported by code: nothing here is under `public/` or `src/`.

- `spec/` is a verbatim copy of the Jira-style specification pack (`00-README.md` to `12-testing-and-acceptance.md`). It was written for a generic Jira Service Management clone, so most of it is adapted or not used (see [Scope](#scope) and [How to use the pack](#how-to-use-the-pack)).
- `mockups/` is a verbatim copy of the approved static mockups: `index.html`, `app.js`, `data.js`, `styles.css`, the mockups' own `README.md`, 19 page files in `pages/` and the screenshots in `screenshots/`. They use sample data and never touch a database.

The owner approved the mockups on 10 November 2026:

> "I like the mock ups but i want to change one thing to it, in the org chart I want to be able to view it as an org tree as well. I also want to be able to add job grades, job titles, and salary brackets. Also remove RTL and arabic from the the design. other that these comments everyhting else is approved to build"

The design that builds from this material is [architecture.md §14](../release-2/architecture.md#14-admin-portal-one-stop-administration), and the ordered build items are in [build-plan.md](../release-2/build-plan.md).

## The three owner changes

1. **Org tree.** The org chart can also be viewed as an org tree: by units, and by people with reporting lines, with vacant positions shown dashed (ORG-101).
2. **Job architecture.** Job grades, job titles, job families and salary brackets per grade (ORG-102 to ORG-107). Salary brackets are confidential under **Plan & pay access**.
3. **No right-to-left and no Arabic** in the design (UI-901).

## Scope

**In scope**, all in one Admin portal at `/app/admin`:

- look and feel and white-label;
- the workflow engine and the workflow designer;
- screens (screen customisation);
- central custom fields;
- users, groups, roles, the permission engine and the hierarchy (company, teams, org units);
- domain and URL;
- notifications;
- outgoing mail;
- integrations (API tokens and AI connections);
- health and monitoring;
- one audit log.

**Not used:** service desk, customer portal, customers, request types, SLAs, item keys, sprints, licences, LDAP, Active Directory and SCIM, clusters, incoming mail, marketplace, "view as user", and Arabic and right-to-left.

**Later:** single sign-on (SAML and OIDC, IAM-030 to IAM-032) comes after Release 2.

### Module summary

Decisions for each of the 307 requirement IDs of the pack (the pack counts 308; `IAM-012` appears only as an example):

| Module                                              | Use | Adapt | Already built | Later | Not used | Total |
| --------------------------------------------------- | --: | ----: | ------------: | ----: | -------: | ----: |
| Identity: users, groups, approval groups, hierarchy |   2 |    17 |             4 |     0 |        4 |    27 |
| Identity: sign-in, sessions and SSO                 |   0 |     5 |             0 |     3 |        1 |     9 |
| Identity: directories, customers and licences       |   0 |     0 |             0 |     0 |       13 |    13 |
| Roles and permissions engine (with the helper)      |   0 |    14 |            14 |     0 |        2 |    30 |
| Workflow engine (SLAs excluded)                     |  15 |    17 |             0 |     0 |        8 |    40 |
| Custom fields (central fields page)                 |   4 |    10 |             0 |     0 |        3 |    17 |
| Screens (screen customisation)                      |   2 |     6 |             0 |     0 |        4 |    12 |
| Look and feel and white-label                       |   3 |     8 |             0 |     0 |        2 |    13 |
| Domain, URL and regional settings                   |   1 |     7 |             2 |     0 |        3 |    13 |
| Notifications                                       |   8 |    20 |             2 |     0 |        0 |    30 |
| Outgoing mail (Resend, optional SMTP)               |   0 |     6 |             0 |     0 |        4 |    10 |
| Health and monitoring                               |   0 |    17 |             0 |     0 |        4 |    21 |
| Audit log                                           |   0 |     3 |             1 |     0 |        3 |     7 |
| Admin portal information architecture               |   3 |     4 |             0 |     0 |        0 |     7 |
| Domain model and tenancy (cross-cutting)            |   0 |     9 |             4 |     0 |        7 |    20 |
| API and data conventions (cross-cutting)            |   0 |     9 |             5 |     0 |        1 |    15 |
| Testing and delivery (cross-cutting)                |   4 |    11 |             8 |     0 |        0 |    23 |
| **Total**                                           |  42 |   163 |            40 |     3 |       59 |   307 |

"Use" means build as the pack says. "Adapt" means build, changed for RecruitmentOS or the platform (Vercel, Neon, Resend, Blob). "Already built" means in Release 1 or R2a today. "Later" is SSO only.

## Term mapping

| The pack says                    | RecruitmentOS says                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| Jira Instance                    | **Company workspace** (one per environment, `app.workspaces`)                              |
| Jira Workspace or Project        | **Team**, the data-isolated unit                                                           |
| Jira Item or Issue               | A **record**: candidate, vacancy, application, interview, offer, onboarding or team task   |
| Jira "Team" (a group of people)  | A **group** (new company object)                                                           |
| Global permissions, admin scopes | **Company authority**: company owner, or company admin with areas (`app.workspace_admins`) |
| Permission scheme                | A **configured role**: pages, actions per resource, field rules and record scope           |
| Item security level              | **Record scope**: all records, my org unit and below, or assigned records                  |

## No right-to-left or Arabic

Right-to-left layout and Arabic are out of scope for the Admin portal and for Release 2 (UI-901). This replaces the right-to-left clause of the pack's principle P-12 (`spec/00-README.md`, "Accessibility & i18n"). WCAG 2.2 AA still applies to every screen. An Arabic interface stays a separate later item (R20-03 in the roadmap); Arabic as a data value, for example a candidate's language, is data and not UI.

Some leftover right-to-left and Arabic traces remain in the copied mockups. They are superseded and must not be built:

| File and line                         | Leftover trace                                                         |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `mockups/pages/branding.js:190`       | Help text "Add an Arabic version on the Localisation page."            |
| `mockups/pages/workflows.js:300`      | Help text "Arabic name is set on the Statuses tab."                    |
| `mockups/pages/workflows.js:740`      | Sample Arabic status names for the Statuses tab                        |
| `mockups/pages/workflows.js:742-743`  | An "Arabic name" column on the Statuses tab, rendered with `dir="rtl"` |
| `mockups/pages/users.js:216`          | A Language select offering "العربية"                                   |
| `mockups/pages/permissions.js:15`     | A `[dir="rtl"]` CSS rule                                               |
| `mockups/pages/organisation.js:64-65` | `[dir="rtl"]` CSS rules for the org tree                               |

"Arabic" as a candidate language option in `mockups/pages/fields.js:41` is sample data, not UI, and is not a trace.

## Database enforcement always stays

Row-level security, the signed tenant context and the restricted runtime roles stay under every admin feature. `authorize()` (`src/lib/authz.ts`) adds checks on top of them in the app; it never replaces them. No admin feature removes or bypasses a database rule. The pack's `PermissionService` is application-only; RecruitmentOS keeps both layers.

## Security adaptations

The pack's wording is not built for these 16 requirements. RecruitmentOS builds the adapted form:

| Requirement IDs                          | Risk                                                                                   | What RecruitmentOS does instead                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SYS-002                                  | A server-side fetch of an admin-entered URL is server-side request forgery (SSRF)      | A browser-side check against `/api/version`, or only domains already attached to the Vercel project                  |
| SYS-003, SYS-005, NTF-042, TST-019       | A base URL taken from the request's Host header allows link poisoning and reset hijack | `BETTER_AUTH_URL` only; the Domain page is read-only and shows a mismatch banner                                     |
| PRM-012, DOM-040 (also IMP-004, TST-001) | An app-only permission service would replace database enforcement                      | `authorize()` in the app and row-level security, signed tenant context and restricted roles in the database          |
| PRM-023, IAM-041, IAM-044                | Groups that grant roles or approvals become a privilege-escalation path                | Group membership that grants anything is role assignment: company owner only, resolved and enforced in the database  |
| PRM-060, FLD-001                         | Helpers could reveal records or hidden fields                                          | The same `authorize()`, read-only, showing nothing the admin could not see themselves                                |
| PRM-064                                  | "View as user" is near-impersonation                                                   | Not used                                                                                                             |
| WFL-044                                  | Forced approvals bypass "people decide"                                                | Cancel with a reason and ask again; never force                                                                      |
| WFL-082, TST-016                         | Webhooks call admin-entered URLs (SSRF, data leak)                                     | HTTPS only, private ranges blocked at send time, HMAC signatures, permission-filtered payloads                       |
| EML-001, DAT-005                         | An admin-entered SMTP host (SSRF, port scanning) and a stored password                 | Self-hosted mode only, ports 465 and 587, private ranges blocked; the password encrypted with an env key, write-only |
| EML-006                                  | Forged bounce webhooks could suppress addresses                                        | Verify the Resend webhook signature                                                                                  |
| BRD-004, BRD-005, BRD-006                | Public logos next to private CVs; SVG or CSS script injection                          | A separate public Blob store; images re-encoded; SVG sanitised or refused; no custom CSS                             |
| NTF-021                                  | The delivery log shows message content with candidate data                             | Company owners only, redacted, short retention                                                                       |
| OBS-002, OBS-011, OBS-020                | Public health or metrics endpoints leak internals; server statistics through a shell   | Minimal public state; metrics behind a token or a private network; read `/proc`, no shell commands                   |
| AUD-001                                  | The runtime role holds `UPDATE` on `app.activity` today                                | Erasure redaction only in owner-run helpers, then drop the grant                                                     |
| SYS-022                                  | Configuration import as an escalation path                                             | Imported as drafts; role and approver changes need a company owner to publish                                        |
| IAM-035                                  | Sensitive admin changes without a fresh sign-in                                        | Re-authenticate for role, authority, domain, mail and group changes                                                  |

## Owner additions

Added by the owner on 10 November 2026; not in the pack:

| ID      | Requirement                                                                                                                                                    | Decision | Notes                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ORG-101 | The org chart can be viewed as an org tree: by units, and by people with reporting lines (vacant positions dashed); zoom, expand and collapse, export an image | Build    | Uses the units, positions and employees built in R2a-13 to R2a-16; a read-only view with the same scope rules as the directory                                                       |
| ORG-102 | Job grades with codes, names and order                                                                                                                         | Build    | Company configuration, versioned and audited                                                                                                                                         |
| ORG-103 | Salary brackets per grade (minimum, midpoint, maximum), currency AED, pay period and what the bracket covers, effective date, versioned                        | Build    | Confidential: only company owners and people given Plan & pay access; never in AI (MCP) results, exports or notifications; open offers keep the bracket version they were made under |
| ORG-104 | Job titles with job family and grade; positions and vacancies pick a job title, so grade and bracket follow                                                    | Build    | Changing a title's grade first shows the affected positions, open vacancies and offers                                                                                               |
| ORG-105 | Job families that group job titles                                                                                                                             | Build    | A simple list                                                                                                                                                                        |
| ORG-106 | The Excel import maps Job title and Grade columns                                                                                                              | Build    | Extends the R2a-17 import; never bracket figures                                                                                                                                     |
| ORG-107 | Offers outside the vacancy's grade bracket need approval from an approval group                                                                                | Build    | Uses the workflow approval steps; the check does not reveal bracket figures                                                                                                          |
| UI-901  | No right-to-left layout and no Arabic in the design                                                                                                            | Decision | Replaces the pack's P-12 right-to-left clause; WCAG 2.2 AA still applies                                                                                                             |

## How to use the pack

The pack's own instructions to agents do not apply inside RecruitmentOS. `spec/00-README.md` §1 calls the pack "authoritative", asks for a Phase 0 gap analysis, the files `AS-IS.md`, `GAP-MATRIX.md` and `DECISIONS.md`, and following Jira behaviour by default when the pack is silent. None of that is done here. The scope decisions in this README supersede the pack.

Precedence, highest first:

1. [architecture.md §14](../release-2/architecture.md#14-admin-portal-one-stop-administration) and [build-plan.md](../release-2/build-plan.md), together with the rest of the Release 2 design and `AGENTS.md`;
2. this README's scope decisions;
3. the spec pack, as reference only, for the in-scope modules;
4. the mockups, as the approved look and flow, except where this README or §14 says otherwise.

Where the build differs from the mockups on purpose, §14 says so. The main cases:

- the Domain page is read-only: the mockup's "Switch to" flow is a checklist, and the switch itself is a deployment change the owner makes (§14.9);
- salary brackets are in AED only; the mockup's currency choice is not built (§14.5);
- Plan & pay access is one grant unless the owner decides otherwise (decision D21); the mockup offers four choices.

## The sample data is sample data

The names, email addresses, IP addresses and the company "Al Noor Holding" in the mockups and screenshots are mockup values, not product data. None of them is seeded, imported or used in tests. Every build item uses its own fictional data.

## How to open the mockups locally

1. From `docs/admin-platform/mockups/`, run `python -m http.server <port> --bind 127.0.0.1`, choosing a free port.
2. Open `http://127.0.0.1:<port>/#/home` and pick a screen from the sidebar.
3. Stop the server (Ctrl+C) when you are done.

## Links

- [architecture.md §14 Admin portal (one-stop administration)](../release-2/architecture.md#14-admin-portal-one-stop-administration)
- [build-plan.md](../release-2/build-plan.md)
- [ROADMAP.md, Release 2](../ROADMAP.md#release-2--configurable-platform)
