# Validation before deployment

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
