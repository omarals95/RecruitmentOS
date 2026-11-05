# Deploying RecruitmentOS

> **Deployment is not authorized.** Release needs the owner's decision; independent review (DEC-02/DEC-03) and Production verification are still open. Hosted sign-in remains disabled in code and Blob CV storage stays disabled. Hosted database startup no longer has a blanket block: it fails closed on the precise checks in [§2](#2-neon-postgresql). In the owner's run on the Neon Preview database, the split runtime role template [postgres-split-runtime-roles.sql](../infrastructure/postgres-split-runtime-roles.sql) is applied, `scripts/db-role-evidence.ts` passes with zero drift, and `npm run test:live-roles` passes 27/27 through the transaction-mode pooler and 27/27 direct, with all fixtures removed. Do not run the template against Production before it is reviewed and approved, enable Blob, import real candidate data, or remove these gates. Follow [identity-boundary-plan.md](identity-boundary-plan.md) and [neon-database-runbook.md](neon-database-runbook.md) for the outstanding implementation and verification work.

The project is prepared for Vercel. No Neon database, S3 bucket, mail account, OAuth client or Vercel project is created by cloning or building the repository. Deployment uses the services you configure below.

## 1. Separate environments

Use separate Neon branches/databases, S3 buckets, email settings and auth secrets for production and previews. Do not attach preview deployments to production candidate data. Protect preview deployments in Vercel; a preview URL is not an access-control boundary. Use Node.js **24.x** and the Next.js framework preset. No static export is used: authentication, database operations and signed CV URLs require the server.

## 2. Neon PostgreSQL

Create a PostgreSQL database in the intended region. Keep its owner connection only in the administrator's local `MIGRATION_DATABASE_URL`; do not add that owner connection to the Vercel application's runtime environment.

After the deployment blockers are resolved and the exact target, migration state and role plan have been verified, follow the [Neon database runbook](neon-database-runbook.md) using the target database's direct owner connection. Do not run migrations yet. Migrations are transactional and tracked in `public.recruitment_migrations`. They include tenant composite foreign keys, uniqueness rules, append-only audit protection, last-owner protection and row-level security. Back up the database before future schema changes. Changes are forward migrations; do not edit migrations already applied to a deployed database.

The legacy shared-role fixture has been removed. [postgres-split-runtime-roles.sql](../infrastructure/postgres-split-runtime-roles.sql) creates the separately restricted `recruitmentos_data` and `recruitmentos_identity` roles with exact object-by-object grants and closes the database and the `public` schema to PUBLIC. `scripts/db-role-evidence.ts` reports their effective privileges read-only and exits 1 on drift from the template's grants; [neon-database-runbook.md](neon-database-runbook.md) lists exactly which classes it checks. Both are verified on PGlite, on a throwaway local PostgreSQL 18 cluster and, in the owner's run, on the Neon Preview database: there the template is applied, the evidence script passes with zero drift, and `npm run test:live-roles` passes 27/27 through the transaction-mode pooler and 27/27 direct, with all fixtures removed. Production is not verified.

Hosted startup (`createDbPair()` in `src/db/index.ts`) fails closed with 503, and no environment variable bypasses it. Before any pool exists it refuses `DATABASE_MODE=pglite` or `ALLOW_LOCAL_DB=true` (`local_db_disabled`), `DEV_MAIL_MODE=console` or any `DEV_SEED_PASSWORD` (`development_setting_refused`), a missing or malformed `TENANT_CONTEXT_SIGNING_KEY` (`tenant_context_unavailable`), and a missing `DATABASE_URL` or `IDENTITY_DATABASE_URL`, URLs for different endpoints or databases, unsupported URL parameters or a non-empty `PGOPTIONS` (`unsafe_database_connections`). Remote pools use `sslmode=verify-full` with certificate verification. After connecting it refuses a session login that differs from the effective role, or an unsafe result from the runtime role safety query (including a role that owns or can assume the database owner) or the marker and per-role boundary queries (`unsafe_database_role`); a missing or mismatched connection marker, the same role on both pools, or a role able to assume the other (`unsafe_database_connections`); and a missing or different storage schema version (`storage_schema_mismatch`). Keep owner credentials out of the application runtime and use TLS with certificate verification for remote connections.

The staged startup checks reject several unsafe role privileges, but they are not a complete privilege audit or proof of tenant isolation. Team policies now derive their context from a signed per-transaction assertion rather than caller-set settings, verified on local PGlite and a throwaway local PostgreSQL 18 cluster, and the adversarial live harness passed on Neon Preview in the owner's run. Do not claim isolation against a compromised runtime SQL role until independent review (DEC-02/DEC-03) and Production verification pass.

## 3. Vercel environment

Set server-only environment variables from `.env.example`:

| Setting                                        | Purpose                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                                 | Pooled restricted runtime Neon connection                              |
| `IDENTITY_DATABASE_URL`                        | Separate restricted identity connection to the same database           |
| `TENANT_CONTEXT_SIGNING_KEY`                   | The tenant context key `npm run db:migrate` installed in this database |
| `BETTER_AUTH_URL`                              | Exact canonical HTTPS application origin, without a path               |
| `BETTER_AUTH_SECRET`                           | Unique cryptographically random secret, at least 32 characters         |
| `BOOTSTRAP_OWNER_EMAIL`                        | Email allowed to register the first owner account                      |
| `BOOTSTRAP_SETUP_TOKEN`                        | High-entropy initial setup token, unique per environment               |
| `ALLOW_PUBLIC_SIGNUP`                          | Keep `false` for invitation-only registration                          |
| `RESEND_API_KEY`, `EMAIL_FROM`                 | Verified sender for verification, invitations and resets               |
| `S3_BUCKET_NAME`, `AWS_REGION`, `AWS_ROLE_ARN` | Private versioned CV bucket and Vercel OIDC role                       |

Never expose these through `NEXT_PUBLIC_*`. The deployed `TENANT_CONTEXT_SIGNING_KEY` must be the key `npm run db:migrate` installed in that database; otherwise every team transaction is denied (403 `tenant_context_denied`). `ALLOW_LOCAL_DB=true`, `DEV_MAIL_MODE=console`, `DATABASE_MODE=pglite` and any `DEV_SEED_PASSWORD` make hosted startup refuse; do not configure them in a deployed environment. The build succeeds without credentials; private routes show setup-required until runtime services are configured. A successful build does not prove cloud credentials or provider permissions are correct.

Import `omarals95/RecruitmentOS` into Vercel and select the reviewed implementation branch. Run `npm ci` for install and `npm run build` for build. The repository includes Vercel's Node function duration configuration. Use a stable canonical production domain matching `BETTER_AUTH_URL`. Preview origins need their own corresponding isolated configuration; do not add arbitrary origins to auth or S3 CORS.

## 4. Email and sign-in

Verify a sending domain with Resend and set `EMAIL_FROM`. Apply the initial-admin migration, then use `/create-admin` with the configured bootstrap email and setup token. Verify the email, sign in, and create the first team in Team & settings; its creator becomes the owner. Setup completes when that verified claimant owns the team. Invitations require a verified account with the matching email. Use separate setup tokens and database claims for preview and production; do not put tokens in URLs, repository files or chat. See [authentication.md](authentication.md) for recovery and upgrade behavior.

For Google, configure the OAuth client and callback `https://YOUR-DOMAIN/api/auth/callback/google`, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. For Microsoft, configure `https://YOUR-DOMAIN/api/auth/callback/microsoft`, set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and optionally `MICROSOFT_TENANT_ID`. Keep callback domains exact. Provider email is not permission to join an existing team, and automatic email-based account linking is disabled. Test each provider's email verification and invitation flow with your tenant before enabling it for recruiters.

## 5. CV storage

Complete [s3-setup.md](s3-setup.md). Public access must be blocked and versioning enabled. Apply bucket CORS only for the exact approved application origins and scope the Vercel AWS trust policy to the intended organisation, project and environment. Do not expire noncurrent CV object versions indiscriminately: a ready database reference can point to one. The application uses immutable version IDs after format validation.

## 6. Launch checks with fictional data

- Verify owner registration, email delivery and verification, password reset and session sign-out.
- Create two teams; confirm a user/token from one cannot access the other's records, source metadata, CV tickets or downloads.
- Invite a recruiter and viewer; check role changes, removal and last-owner protection.
- Create/edit candidates, vacancies, application stages, task buckets/fields, interviews, offers and onboarding checklists. Verify conflicts preserve drafts.
- Upload a small fictional CV, complete its validation and download it. Check S3 versioning, exact-origin CORS and expired links. Unconfigured storage must fail closed.
- Create a narrowly scoped token; confirm read/write/upload limits, expiration, revocation and rate limiting. Confirm tokens cannot manage teams or mint other tokens.
- Verify no secrets or candidate payloads appear in public pages, logs, analytics services or the repository.

Then run the migration dry-run, review its candidate/file/duplicate/exception counts, and explicitly apply it only after reconciling those results. Do not assume that a count of source files equals a count of unique candidates.

## Operations

Enable Neon backup/restore appropriate to your retention policy and S3 recovery protections. Monitor application failures, provider costs, upload reservations and rate limits without logging CV contents, passwords, tokens or signed URLs. Define retention, deletion, offboarding and incident response before real use. CV format validation is not antivirus scanning; if malware scanning is required, add a private quarantine/scanning gate before making files ready. See [security.md](security.md) for implementation limits and authorised network flows.
