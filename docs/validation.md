# Validation before deployment

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
