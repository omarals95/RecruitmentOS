# Deploying RecruitmentOS

The project is prepared for Vercel. No Neon database, S3 bucket, mail account, OAuth client or Vercel project is created by cloning or building the repository. Deployment uses the services you configure below.

## 1. Separate environments

Use separate Neon branches/databases, S3 buckets, email settings and auth secrets for production and previews. Do not attach preview deployments to production candidate data. Protect preview deployments in Vercel; a preview URL is not an access-control boundary. Use Node.js **24.x** and the Next.js framework preset. No static export is used: authentication, database operations and signed CV URLs require the server.

## 2. Neon PostgreSQL

Create a PostgreSQL database in the intended region. Keep its owner connection only in the administrator's local `MIGRATION_DATABASE_URL`; do not add that owner connection to the Vercel application's runtime environment.

Install with `npm ci`, set the owner connection in an ignored `.env.local`, then run `npm run db:migrate`. Migrations are transactional and tracked in `public.recruitment_migrations`. They include tenant composite foreign keys, uniqueness rules, append-only audit protection, last-owner protection and row-level security. Back up the database before future schema changes. Changes are forward migrations; do not edit migrations already applied to a deployed database.

After migrations, review and run [postgres-runtime-role.sql](../infrastructure/postgres-runtime-role.sql) as owner. Replace `neondb` if the database has a different name, set the role's password securely, and generate a **pooled Neon connection string for that runtime role**. Put that connection in Vercel's `DATABASE_URL`. Use TLS; the application enforces certificate verification for remote PostgreSQL connections. Do not grant the runtime role membership of the owner role.

The production application refuses a role that is a superuser, has BYPASSRLS, owns an app table or inherits its ownership. Auth tables are managed through Better Auth; business tables have transaction-scoped team policies as well as explicit server membership checks. Database migrations and runtime credentials serve different purposes.

## 3. Vercel environment

Set server-only environment variables from `.env.example`:

| Setting                                        | Purpose                                                        |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                                 | Pooled restricted runtime Neon connection                      |
| `BETTER_AUTH_URL`                              | Exact canonical HTTPS application origin, without a path       |
| `BETTER_AUTH_SECRET`                           | Unique cryptographically random secret, at least 32 characters |
| `BOOTSTRAP_OWNER_EMAIL`                        | Email allowed to register the first owner account              |
| `BOOTSTRAP_SETUP_TOKEN`                        | High-entropy initial setup token, unique per environment       |
| `ALLOW_PUBLIC_SIGNUP`                          | Keep `false` for invitation-only registration                  |
| `RESEND_API_KEY`, `EMAIL_FROM`                 | Verified sender for verification, invitations and resets       |
| `S3_BUCKET_NAME`, `AWS_REGION`, `AWS_ROLE_ARN` | Private versioned CV bucket and Vercel OIDC role               |

Never expose these through `NEXT_PUBLIC_*`. Do not configure local database flags or `DEV_MAIL_MODE=console` in production. The build succeeds without credentials; private routes show setup-required until runtime services are configured. A successful build does not prove cloud credentials or provider permissions are correct.

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
