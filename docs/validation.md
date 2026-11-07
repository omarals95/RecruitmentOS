# Validation before deployment

## Update: speed (P1-18)

**What changed.** Functions are set to `fra1` (Frankfurt) in `vercel.json`, next to Neon and Blob; it applies on the owner's next deployment. Every `runApi` response carries `Server-Timing: total;dur=<ms>, db;dur=<ms>, dbrt;desc="<count>"`, counted per request across both database pools (every statement, `BEGIN`, `COMMIT` and `ROLLBACK`). Signed-context transactions read the backend, transaction, marker and clock in the same statement as the deadlines, and `listRecords` reads the total with the page (`count(*) over ()`), with the old count only for an empty page past the first. In the browser, quick actions update at once and roll back with a message, every read is cached per user, team and path (shown at once, refreshed in the background), the daily tabs are prefetched and screens show skeletons. Vercel Speed Insights and the built-in speed log (migration `0020`, Workspace settings > Speed) record real-use timings.

**Round trips: before and after.** `npm run bench:round-trips` on the worktree's fictional PGlite database, signed in as the fictional seed owner. Counts include the Better Auth session lookup (2 round trips) and the membership select; times are medians of 5 runs after one warm-up. "Before" is commit `d3cd6d1` (instrumentation only), "after" is this branch.

| Action               | Request                                                                           | Before | After | db ms before → after | total ms before → after |
| -------------------- | --------------------------------------------------------------------------------- | -----: | ----: | -------------------: | ----------------------: |
| move task            | `PATCH /api/v1/tasks/:id`                                                         |     14 |    13 |          14.6 → 11.3 |             20.3 → 15.5 |
| change stage         | `PATCH /api/v1/applications/:id`                                                  |     14 |    13 |          13.8 → 11.1 |             19.4 → 16.0 |
| open Overview        | `GET /api/v1/overview`                                                            |     24 |    22 |          22.1 → 25.1 |             27.9 → 31.2 |
| open Candidates      | `GET /api/v1/candidates?page=1&pageSize=25&search=&sort=name&direction=asc`       |     10 |     8 |            8.4 → 6.3 |              11.6 → 8.9 |
| open Candidates      | `GET /api/v1/views?pageSize=100&area=directory`                                   |     10 |     8 |            8.6 → 4.5 |              12.1 → 6.6 |
| open My shortlist    | `GET /api/v1/candidates?…&shortlisted=true`                                       |     10 |     8 |            7.5 → 4.2 |              10.8 → 6.0 |
| open My shortlist    | `GET /api/v1/views?pageSize=100&area=directory`                                   |     10 |     8 |            7.3 → 4.2 |              10.2 → 5.9 |
| open Vacancies       | `GET /api/v1/vacancies?page=1&pageSize=25&search=&sort=updatedAt&direction=asc`   |     10 |     8 |            6.7 → 4.2 |               9.7 → 6.0 |
| open Job roles       | `GET /api/v1/job-roles?…`                                                         |     10 |     8 |            7.2 → 5.0 |              10.2 → 7.8 |
| open Applications    | `GET /api/v1/applications?…`                                                      |     11 |     9 |            8.7 → 5.3 |              12.1 → 7.3 |
| open Applications    | `GET /api/v1/views?pageSize=100&area=applications`                                |     10 |     8 |            7.7 → 4.6 |              10.6 → 6.3 |
| open Tasks           | `GET /api/v1/tasks?page=1&pageSize=25&search=&sort=updatedAt&direction=asc`       |     10 |     8 |            6.5 → 4.9 |               9.3 → 7.1 |
| open Tasks           | `GET /api/v1/buckets?pageSize=100&sort=position&direction=asc`                    |     10 |     8 |            7.0 → 4.7 |               9.9 → 6.7 |
| open Interviews      | `GET /api/v1/interviews?page=1&pageSize=100&startFrom=…&startTo=…&sort=createdAt` |     10 |     8 |            8.1 → 4.9 |              11.5 → 7.0 |
| open Offers          | `GET /api/v1/offers?…`                                                            |     10 |     8 |            6.9 → 5.1 |               9.5 → 7.3 |
| open Offers          | `GET /api/v1/analytics`                                                           |     21 |    20 |          21.9 → 15.7 |             25.3 → 18.7 |
| open Onboarding      | `GET /api/v1/onboarding?…`                                                        |     12 |    10 |            9.4 → 5.8 |              12.9 → 7.8 |
| open Analytics       | `GET /api/v1/analytics?from=&to=`                                                 |     21 |    20 |          20.2 → 20.6 |             23.3 → 24.4 |
| open Talent insights | `GET /api/v1/analytics?from=&to=`                                                 |     21 |    20 |          19.8 → 18.6 |             23.0 → 21.7 |
| open Talent insights | `GET /api/v1/overview`                                                            |     24 |    22 |          19.7 → 19.0 |             25.3 → 24.5 |
| open Source review   | `GET /api/v1/candidates?…&needsReview=true`                                       |     10 |     8 |            7.2 → 5.4 |               9.8 → 7.6 |
| open Source review   | `GET /api/v1/views?pageSize=100&area=directory`                                   |     10 |     8 |            6.0 → 5.0 |               8.5 → 7.3 |
| open Activity        | `GET /api/v1/activity?page=1&pageSize=50&search=&kind=`                           |     10 |     9 |            9.9 → 9.0 |             12.8 → 11.7 |
| open Notifications   | `GET /api/v1/notifications`                                                       |     10 |     9 |            9.8 → 9.5 |             12.7 → 11.7 |
| open candidate       | `GET /api/v1/candidates/:id` (the profile's only first-load GET)                  |      9 |     8 |            5.5 → 5.0 |               7.9 → 7.0 |
| save candidate       | `PATCH /api/v1/candidates/:id`                                                    |     12 |    11 |            9.7 → 7.4 |             13.3 → 11.0 |
| schedule interview   | `POST /api/v1/interviews`                                                         |     14 |    13 |            9.4 → 8.7 |             12.8 → 12.5 |

Each page load also requests the shell's notification count (`GET /api/v1/notifications`) once. `tests/round-trip-budget.test.ts` asserts the counts with the session lookup mocked: `GET /api/v1/tasks?page=1&pageSize=25` 8 → **6**, `GET /api/v1/candidates/:id` 7 → **6**, `PATCH /api/v1/tasks/:id` bucket move 12 → **11**, `PATCH /api/v1/applications/:id` stage change 12 → **11** (the before values were confirmed on the instrumentation commit), plus correct `pagination.total` on the first page, a middle page and a page past the end.

**What remains for a simple read** (`GET /api/v1/tasks`, 6 after the session lookup):

1. Membership select on the identity pool: the caller's current team role, read on every request (no cached role).
2. `BEGIN`: one transaction holds the signed context and the deadlines.
3. Deadlines and snapshot in one statement: `statement_timeout` and `transaction_timeout` (SRS-NFR-05), plus the pid, xid, environment marker and clock the context is signed for.
4. `select tenant_context.install(payload, signature)`: checks the HMAC, pid, xid, expiry, membership and token state before any row policy allows access.
5. The page with its total (`count(*) over ()`) under FORCE row-level security.
6. `COMMIT`: the context and deadlines end with the transaction.

**What remains for a simple write** (task bucket move, 11): the same first four, then `lockTeam` (team advisory lock that serialises writes), `find … FOR UPDATE` (row lock and the version check behind 409), `checkReferences` (the bucket belongs to the team and is active), `checkCustomValues` (required and typed custom task fields), the update, the `audit()` activity insert, and `COMMIT`. A stage change has `uniqueChecks` (one active application per candidate and vacancy) and `decorate` (labels) instead of the two task checks.

**The owner's target is not met.** The target of at most 4 round trips for a simple read and 6 for a simple write is not reached (6 and 11). The signature must cover a server-read pid and xid, so the snapshot cannot merge into `tenant_context.install` without changing the security protocol; merging `BEGIN` would need a custom transaction runner, and the write checks and audit would need query rewrites. Further cuts need an owner decision: a cookie-cached session (revocation delay), the role carried in the session, a changed context protocol or a custom transaction runner (spec Assumption 1). With functions in `fra1` beside the database each round trip costs about 1-2 ms instead of about 90 ms across the Atlantic.

**Follow-up (not changed).** Application cards label their candidate and vacancy with one cached `GET` each (`ReferenceLabel`): a 25-card Applications board issues up to 25 candidate GETs plus one per distinct vacancy (8 round trips each, session included). The cache now shares these requests across cards and screens; changing how cards get their labels is out of scope.

**Browser check.** `npm run dev -- --port 5420` on the worktree's PGlite (the worktree's `.env.local` pointed `BETTER_AUTH_URL` at the port for the check, then back), fictional seed owner, `agent-browser`:

- Tasks: changing a card's "Move … to" select showed the card in the new column 17 ms after the change event, with its select disabled and no skeleton or spinner on the board; it stayed disabled until the PATCH returned (2.4 s on the first dev compile), then "Task moved." showed, the select was enabled again, and no task or bucket list was requested again (only the shown notifications revalidated).
- Tasks → Candidates → Tasks: the task board was on screen 80 ms after the click, from the cache; the route skeleton (`src/app/app/loading.tsx`) showed for about 45 ms while the dev server answered, with no spinner or blank area.
- Team switch: after creating a fictional second team, switching from Fictional Studio to it with the team switcher showed no Fictional Studio task in any of 57 sampled frames on the second team; its board was empty.
- Settings → Speed as the owner, after moves and tab switches and a wait over 10 seconds: actions (`tab.candidates`, `tab.overview`, `tab.pipeline`, `tab.tasks`, `tab.vacancies`, `task.move`) and API routes (for example `GET /api/v1/candidates/[id]`, `GET /api/v1/tasks`) with typical, slow and database times and sample counts; the dev server logged each `POST /api/v1/speed-samples` as 202.
- The browser was closed and the dev server stopped afterwards.

**Not representative.** `next dev` compiles routes on first use and PGlite runs in the server process, so local milliseconds (and the dev PATCH times above) say little about hosted speed; the round-trip counts are the portable result. `npm run build && npm run start` is the closer local measurement.

**Validation.** Node v24.20.0: `npm run typecheck`, `npm run lint`, `npm test` (974 Vitest tests in 78 files, none skipped), `npm run test:storage` (57 native storage tests), `npm run build`, Prettier on every changed file and `npm audit --audit-level=moderate` (found 0 vulnerabilities) all pass. `@vercel/speed-insights` is pinned at 2.0.0. Migration `0020_speed_log.sql` applied to the worktree's PGlite with `npm run db:migrate`. New tests: `tests/round-trip-budget.test.ts`, `tests/data-cache.test.ts`, `tests/optimistic-actions.test.ts`, `tests/tab-requests.test.ts`, `tests/speed-insights.test.ts`, `tests/speed-log.test.ts`; extended: `tests/transaction-deadlines.test.ts`, `tests/tenant-context.test.ts`, `tests/workspace-render.test.tsx`, `tests/settings-ui.test.tsx`, `tests/runtime-role-grants.test.ts`, `tests/openapi-contract.test.ts`.

No remote service was contacted other than the npm registry for `@vercel/speed-insights` and `npm audit`: tests and the benchmark use PGlite and fictional data only, and Speed Insights renders nothing outside production builds. Owner steps: deploy to apply `fra1`; apply `0020` on Preview, rerun the role template, `scripts/db-role-evidence.ts` and `npm run test:live-roles`; turn Neon scale-to-zero off for the Production compute; then P1-20 in the Vercel dashboard.

## Update: security patch release (P1-19)

**Local validation.** On 7 November 2026, with Node v24.20.0, job 031 passed `npm run typecheck`, `npm run lint`, `npm test` (924 Vitest tests in 72 files, none skipped), `npm run test:storage` (57 native storage tests), `npm run build` (Next.js 16.4.5), Prettier repo-wide (`npx prettier --check . --end-of-line auto`; a plain `npm run format:check` reports this Windows checkout's CRLF working copies, as recorded for jobs 029 and 030) and `npm audit` (`found 0 vulnerabilities`; `npm audit --audit-level=moderate` exits 0). `npm ls` shows next and `@next/eslint-plugin-next` 16.4.5, `better-auth`, `@better-auth/core` and `@better-auth/drizzle-adapter` 1.7.18, `@vercel/oidc` 4.0.7, `@vercel/functions` 3.11.0, `@electric-sql/pglite` 0.5.15, the three S3 packages 3.1164.0, `@aws-sdk/credential-provider-web-identity` 3.972.88, `lucide-react` 1.70.0, `vitest` 5.1.0, `write-excel-file` 4.1.1 (now pinned exactly), TypeScript 6.0.3 and `@types/node` 24.19.2; no dependency was added or removed and no `overrides` entry was needed. Migration `0019_blob_upload_abuse_controls.sql` applied to the worktree's PGlite with `npm run db:migrate`.

New and changed tests: `tests/auth-flows.test.ts` (padded and differently cased owner roles refused for invitations and role changes, for an admin and an owner; team creation refused for a recruiter and an admin who owns no team and allowed for the initial administrator and an owner; control, bidi and zero-width characters removed from the invitation mail), `tests/auth-lifecycle.test.ts`, `tests/settings-ui.test.tsx`, `tests/api-token-gate.test.ts` and `tests/mcp-endpoint.test.ts` (live tokens admitted from an over-budget shared address, unknown and revoked tokens 429), `tests/csp.test.ts` (HSTS, COOP, no upload host when the provider is unset), `tests/records-postgres.test.ts`, `tests/mcp-endpoint.test.ts` and `tests/cv-blob-transfer.test.ts` (candidate scopes for comments and CV reads), `tests/blob-reconciliation.test.ts` and `tests/cv-blob-transfer.test.ts` (multipart oversize, wrong type, delete-then-replay, ticket cap, automatic sweep, cooldown, early rate check), `tests/cv-inline-content.test.ts` (DEC-07), `tests/tenant-context.test.ts`, `tests/runtime-role-grants.test.ts`, `tests/cv-storage-migration.test.ts`, `tests/migration-upgrade.test.ts`, `tests/connection-boundary-boot.test.ts`, `tests/db-pool-preflight.test.ts` and `tests/openapi-contract.test.ts`.

**Dev server.** `npm run dev -- --port 5410` on the worktree's PGlite: `/sign-in` and `/oauth/authorize` answered with `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `Cross-Origin-Opener-Policy: same-origin` and, with `CV_STORAGE_PROVIDER` unset, `connect-src 'self'` plus the development `ws:` entries only. Signed in as the fictional seed owner (the initial administrator), Team & access showed **Create a team**. A fictional recruiter invited through the page, registered and verified through the console mail, and not yet a member saw "You have not joined a team yet. Accept the email invitation from your team owner." on Team & access and Overview with no form, and `POST /api/auth/organization/create` answered 403. The server was stopped afterwards.

No remote service was contacted other than the npm registry for the listed upgrades: tests use PGlite, the fake Blob client and fictional data only. Owner steps: apply `0019` with `0018` on Preview, rerun the role template, `scripts/db-role-evidence.ts` and `npm run test:live-roles`, set `CV_STORAGE_PROVIDER=blob` before the build, and check HSTS, COOP and the Claude and ChatGPT connector OAuth flow on Preview.

## Update: private Vercel Blob CV storage enablement (P1-15a)

**Owner's live run.** On 7 November 2026 the owner ran `scripts/blob-live-verify.ts` against the Preview Blob store; agents did not run it. Results:

- PASS headers.
- PASS no-overwrite.
- PASS replay.
- PASS oversized single PUT refused.
- PASS PUT started after expiry refused.
- PASS deleted object reads missing.
- PASS cleanup.
- OBSERVED a PUT started before expiry and finished after it was refused (no object).
- FAIL a wrong content type was accepted by the provider.
- FAIL multipart with the PUT ticket bypassed the size limit (oversized parts and completion accepted; uncompleted parts cannot be listed).
- OBSERVED retrying a still-valid ticket after deletion recreated the object.

Mitigations ([blob-security-design.md](blob-security-design.md#live-provider-verification)): completion checks size and type with `head` and never trusts the provider, Blob reservations last 15 minutes with tickets still capped at 300 s, and rejected or abandoned objects are deleted only 10 minutes after their reservation expired, with the retained charge freed only once `head` confirms the object missing. Residual risk: multipart with a valid PUT ticket can bypass the size limit, and uncompleted parts cannot be listed or deleted by the application, so store usage can exceed the ledger until the provider discards them; limits and budgets are application limits, not hard provider or billing caps.

**Supersedes older entries.** From this update, Blob is the hosted CV storage provider in code; the statements in the older entries below that Blob CV storage is disabled or remains disabled are history and no longer describe the code.

**Local validation.** On 7 November 2026, with Node v24.20.0, the local revision passed `npm run typecheck`, `npm run lint`, `npm test` (886 Vitest tests in 71 files), `npm run test:storage` (57 native storage tests), `npm run build`, Prettier repo-wide (`npx prettier --check . --end-of-line auto`) and `npm audit --audit-level=moderate` (0 vulnerabilities); `tests/runtime-role-grants.test.ts` passed 64 tests on its own. No dependency was added. Migration `0018_blob_storage_enablement.sql` applied to the worktree's PGlite: `db_boundary.storage_schema` reads 3 and `storage_ledger.budgets` still holds 600,000,000 / 2,000 (Production) and 200,000,000 / 500 (Preview and development). On the dev server, signed in with the fictional seed owner, the Team & access **CV storage** panel showed usage, both toggles and Save; 0.5 GB and 100 files saved with "CV storage settings saved.", showed again after a reload, and Activity on Overview listed "Updated CV storage settings".

New and changed tests: `tests/storage.test.ts` (provider selection, OIDC refusals), `tests/blob-client-contract.test.ts` (OIDC mode; head, delete and list for the fake and the real client), `tests/csp.test.ts`, `tests/cv-blob-transfer.test.ts` (oversized and wrong-type rejection without a read, 15-minute reservations), `tests/blob-reconciliation.test.ts` (post-expiry ordering, list pass, caps, counts only, server trigger, endpoint), `tests/team-storage-settings.test.ts` (settings, validation, audit, 429, helper boundary), `tests/tenant-context.test.ts` (helpers under the split data role), `tests/settings-ui.test.tsx`, and the 200-file batch cases in `tests/bulk-intake.test.ts`, `tests/bulk-cv-queue.test.ts` and `tests/workspace-render.test.tsx`.

No remote service was contacted: tests use the fake Blob client, a stub provider and PGlite with fictional data only, and no agent ran the live script. Hosted Preview switch-on waits for the owner: the environment settings in [deployment §5](deployment.md#5-cv-storage), migration `0018` and the role template rerun.

## Update: documentation and configuration reconciliation (WP-15)

On 7 November 2026, the local revision passed TypeScript, ESLint on the changed component, Prettier on the changed files and repo-wide (`npx prettier --check . --end-of-line auto`), a production build, 829 Vitest tests in 69 files and 55 native storage tests; `tests/runtime-role-grants.test.ts` passed 64 tests on its own. The change is documentation, one role-template comment, one sentence of API-token page copy and one CI step, which now runs `npm run format:check`. The runbooks, the Preview change plan and the identity plan now record the Preview evidence and the precise hosted startup checks, the BRD, SRS and brief carry dated status notes, and [neon-database-runbook.md](neon-database-runbook.md#run-the-migration-against-a-neon-database) documents how to migrate a hosted database without `npm run db:migrate`. That procedure was checked locally only: run from a temporary directory holding only `drizzle/`, against a fictional closed loopback port, `scripts/migrate.ts` skipped PGlite and printed its generic connection failure (exit 1), while `npm run db:migrate` from the checkout migrated local PGlite and printed `Local PostgreSQL migrations applied.` although `MIGRATION_DATABASE_URL` was set. No hosted database or other remote service was contacted.

## Update: accessibility and responsive checks (WP-08)

On 7 November 2026, the local revision passed TypeScript, ESLint, Prettier on the changed files, a production build, 829 Vitest tests in 69 files and 55 native storage tests. It names the calendar "+N more" button with its day and makes it 24 px tall, gives the phone search button a name at every width, takes the closed phone menu out of the tab order, removes the `opacity` that left outside-month days and cancelled interviews under 4.5:1, and stops visually hidden text in the board and tables from widening the page. `tests/workspace-ui.test.ts` and `tests/workspace-render.test.tsx` cover each fix, and each new test failed when its fix was reverted. A keyboard-only walkthrough in Chromium through `agent-browser` on the local development server, at 360×740, 640×800 (standing in for 200% zoom) and 1280×800 in light and dark, with the fictional seed account and fictional records in local PGlite, is recorded with its known gaps in [accessibility-checklist.md](accessibility-checklist.md). No screen reader, other browser or automated accessibility lint was run, D-13 is undecided, and no WCAG conformance is claimed.

## Update: MCP endpoint for AI assistants (WP-16)

On 5 November 2026, the local revision passed TypeScript, ESLint, Prettier on the changed files, a production build, 575 Vitest tests in 50 files, 55 native storage tests and `npm audit --audit-level=moderate` (0 vulnerabilities). It adds `POST /api/mcp` ([mcp.md](mcp.md)) with the pinned `@modelcontextprotocol/sdk` 1.32.2, a minimal OAuth 2.1 server and migration `0010_mcp_oauth.sql`. `tests/mcp-endpoint.test.ts` (19 tests) runs the real route against PGlite under a nonowner RLS role and the split data role: Bearer-only access, the guess budget and per-token limit, team binding, scope and current-role checks per tool, field filtering, caps, Asia/Dubai times, idempotent writes, prompt-injection text treated as data, and the `mcp-tool` audit rows that the data role cannot forge. `tests/mcp-oauth.test.ts` (10 tests) covers readiness, metadata, registration, consent, exact redirect matching, PKCE, code expiry and reuse, audience binding, lifetimes, refresh rotation and Settings revocation. A browser check on the local development server signed in with the fictional seed account, approved a fictional client on the consent page, redeemed the code, called the tools and revoked the connection in Settings. Live Claude.ai and Claude Code connections, and migration `0010` and the role template on Preview, are not verified.

## Update: signed tenant context

On 4 November 2026, the local revision passed TypeScript, ESLint, formatting of the changed files, a production build, 205 Vitest tests in 32 files and 52 native storage tests. Migration `0006_trusted_tenant_context.sql` replaces the GUC tenant policies with a signed per-transaction context, token create/revoke now audits in one identity-role transaction, and activity names come from a context-checked accessor. The five research tests and four SQL fixtures were removed, and their relevant cases were moved into `tests/tenant-context.test.ts`. That file and the rewritten role-boundary tests run the real migrations under synthetic split roles: a nonsuperuser, non-BYPASSRLS owner and separate data and identity roles that cannot assume each other. This is PGlite-only evidence on one connection. It does not establish live Neon privileges, concurrent revocation, pooler behaviour or lock contention, and the design has not been independently reviewed. The hosted `tenant_isolation_pending` guard remains closed.

## Update: staged connection and workflow review

On 3 November 2026, the local staged revision passed TypeScript, ESLint, formatting, 196 Vitest tests and 46 native storage tests; one synthetic Windows junction test was skipped. The paired-pool connection checks now reject unsupported URI options and unexpected startup options, normalize ports, and check the inspected login and effective roles. They do not establish safe state on every future pool checkout, and the legacy single-pool development path does not have the same checks. Token/audit and activity-name integration remain unfinished. The activity accessor experiments use synthetic data and are not deployed. No live Neon connection, migration, production policy change or Blob-provider verification was performed.

## Update: local audit and activity experiments

On 3 November 2026, the local staged revision passed TypeScript, ESLint, formatting, a production build, 184 Vitest tests and 46 native storage tests; one synthetic Windows junction test was skipped. The new audit, activity-name and rollback experiments use fictional records in PGlite and remain unintegrated. They do not establish real lock contention, revocation, concurrent activity-name changes, safe claim replay, live Neon privileges or Blob provider behavior. A fresh temporary local PostgreSQL instance could not be reached on loopback in the sandbox and was stopped and removed. Hosted access and Blob remain disabled.

## Update: local isolation experiments

On 3 November 2026, the staged revision passed TypeScript, ESLint, formatting, a production build, 159 Vitest tests and 46 native storage tests; one synthetic Windows junction test was skipped. New local tests characterize token-and-audit transaction boundaries and exercise a test-only private-row isolation proof. Hosted sign-in and database access remain blocked, the protected-context proof remains unintegrated, and the known savepoint replay gap remains unresolved. The role check for known PostgreSQL filesystem helpers is defense in depth, not an exhaustive privilege audit. No live Neon or Blob security behavior was established.

## Update: staged identity boundary

On 3 November 2026, the local staged revision passed TypeScript, ESLint, formatting, the production build, 148 Vitest tests and 46 native storage tests; one synthetic Windows junction test was skipped. Better Auth and token routing were exercised with synthetic PGlite roles. The tenant-context fixture is research only: it demonstrates a savepoint replay gap and is not used by the application. Hosted and production database access is deliberately blocked until verified tenant policies, audit and activity workflows, and role provisioning are complete. No cloud migration or live-Neon isolation test was performed.

## Update: role guard and isolated Blob components

On 3 November 2026, the current revision passed TypeScript, ESLint, formatting, 113 Vitest tests and 46 native storage tests; one synthetic Windows junction test was skipped. Role-safety tests exercise effective inherited, public and column grants and missing schemas against PGlite. Blob ticket creation and chunk assembly tests use synthetic signers and files. These components remain unwired: they do not establish authorized upload, quota enforcement, replay safety, live provider behavior, browser integration or end-to-end download safety. Blob remains disabled; actual Neon role permissions and concurrency must still be verified.

## Update: first-admin privileges and Blob validation

On 3 November 2026, the current revision passed TypeScript, ESLint, formatting, 109 Vitest tests and 30 native storage tests; one synthetic Windows junction test was skipped. The new first-admin migration and role grants were exercised with nonowner roles in PGlite, including legacy grants and normal setup. Actual Neon roles and multi-connection behavior have not been verified. The new Blob completion validator is not wired to the application, and Blob CV storage remains disabled. A proposed quota ledger was removed during review because the shared runtime SQL role can forge the team and user context; see [blob-quota-design.md](blob-quota-design.md).

## Update: Blob integrity component

On 3 November 2026, a standalone, unwired Blob integrity component passed six synthetic tests. The complete native storage suite passed 24 tests; 106 Vitest tests passed with one Windows junction test skipped. TypeScript, ESLint and formatting checks also passed. These checks do not establish provider behavior, end-to-end upload or download safety, quota cleanup, or live concurrency. Blob CV storage remains disabled. See [blob-security-design.md](blob-security-design.md).

## Update: first-admin setup and storage provider guard

On 3 November 2026, the updated code passed TypeScript, ESLint, 106 Vitest tests and 18 native storage tests. One Windows junction test remained skipped because the sandbox could not create its test junction. Initial-admin tests use fictional accounts and an embedded database; they cover the durable claim, authorization, verification, team-owner completion and interrupted delivery. Live Neon multi-connection races and actual email delivery remain staging checks.

The Vercel Blob provider is deliberately disabled until immutable, validated downloads can be guaranteed with the application's existing CV size limit. Tests confirm an explicit Blob selection fails closed rather than falling back to S3. The automated tests did not use live cloud resources or credentials.

Local validation on 2 November 2026 used Node.js 24.20.0 on Windows, a fictional PGlite workspace, and fake S3 clients. No real candidate records were imported and no live AWS, Neon, Resend or OAuth resources were used.

| Check                                             | Result                             |
| ------------------------------------------------- | ---------------------------------- |
| TypeScript                                        | Passed                             |
| ESLint                                            | Passed                             |
| Production Next.js build                          | Passed, including generated routes |
| Vitest                                            | 99 passed; 1 skipped               |
| Native storage tests                              | 17 passed                          |
| Running local Next.js HTTP workflow               | 67 assertions/requests passed      |
| Online npm advisory audit of the release lockfile | 0 known advisories reported        |

The skipped test creates a synthetic filesystem junction; the Windows sandbox denied that capability. Other traversal, drive/UNC, source-boundary and migration tests passed. This is not verification of every possible filesystem/reparse configuration.

The HTTP workflow verifies fictional sign-in/session cookies, team selection, authenticated rendering of all workspace sections, candidate/role/vacancy/application/task/interview/offer/onboarding/checklist/comment operations, stale-version conflicts, folder filters, summaries, activity filters, private follow-up, API documentation, unconfigured-storage failure, cross-origin denial, token scope/team restrictions and revocation. Its test records are archived and its token is revoked.

Database tests apply the actual SQL migrations and exercise tenant RLS using a nonowner role, composite references, uniqueness, rollback, idempotency, private state/views, workflow constraints, source-import rules, observed-history statistics and paginated CV references. Auth tests call the actual Better Auth handler against PGlite for verified/invitation-only registration, resets, invitations, origin/body limits and membership protections. Storage tests sign only fictional data locally and use fake storage for upload validation, exact version references, quotas and tenant isolation.

Public landing and sign-in screens were visually inspected in the browser. Signed-in browser interaction checks were not completed; the actual sign-in endpoint and assembled application were subsequently verified through HTTP. Do not treat those HTTP checks as a complete interactive browser or accessibility audit. The UI helpers, refresh/draft state and date/calendar behavior have automated regression tests.

## Staging checks still required

- Connect the restricted runtime Neon role and verify pooling, transactions and row-level security against the real database.
- Apply S3 public-access/versioning/CORS/IAM policies and verify the hosted Vercel OIDC context, upload, validation and download end to end.
- Verify delivered email, reset/invitation links, and each optional Google/Microsoft provider with the intended tenant and canonical origin.
- Walk through the signed-in UI on desktop and phone, including keyboard dialogs, drag/move alternatives, dark mode, conflicts and slow/failed requests.
- Review the migration dry-run counts/exceptions before explicitly applying real data, then reconcile candidate records against CV files.
- Validate backup restoration, retention, operational budgets, logging policy and the organisation's malware/quarantine requirements.

See [deployment.md](deployment.md) and [security.md](security.md). A clean package audit and passing tests are evidence about this build, not a guarantee that no vulnerabilities exist.
