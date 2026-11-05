# RecruitmentOS

A React and TypeScript recruitment workspace, built with Next.js for Vercel, Neon PostgreSQL and private Amazon S3 CV storage.

## What is included

- Public landing page and a signed-in dashboard, with light, dark and system themes.
- Verified email/password sign-in, password reset, optional Google/Microsoft, invitations and teams with owner/admin/recruiter/viewer roles.
- Candidate directory, factual filters, saved views, personal shortlist and notes, evidence/source review, multiple CV versions, comments, exports and bulk vacancy assignment.
- Job roles, vacancies, application pipelines, configurable task buckets and fields, interviews/calendar, offers, onboarding/checklists, reminders, analytics and audit history.
- User/team-scoped API tokens with explicit read/write/CV/import scopes, expiration, revocation and persistent rate limits.
- A remote MCP endpoint for AI assistants such as Claude, with API-token or consented OAuth access, read-only tools by default and audited calls ([docs/mcp.md](docs/mcp.md)).
- A dry-run-first migration tool for the earlier Excel/SQLite dashboard. Real records are never bundled with this project.

PostgreSQL is the live data store. Excel imports and exports are transfer tools; they are not a two-way sync. Cloud CV actions open/download private objects; Windows File Explorer is not available from a cloud deployment. Source folder names remain descriptive categories, not an assessment of a candidate's suitability.

## Local development

Use Node.js 24 LTS and npm. Clone this repository, then:

```powershell
npm ci
Copy-Item .env.example .env.local
```

Edit `.env.local`: use a random secret of at least 32 characters, set `BETTER_AUTH_URL=http://localhost:3000`, and enable the **fictional local development database** with `DATABASE_MODE=pglite`, `ALLOW_LOCAL_DB=true`, `DEV_MAIL_MODE=console`. Optionally set a local-only `DEV_SEED_PASSWORD` of at least 12 characters. Do not put real candidate records in the demo.

```powershell
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`. The seed command prints the fictional local login. The local seed is disabled in production and never creates a cloud account or uploads a CV. Email links appear only in the development terminal. S3 upload controls show a setup message until private storage is configured.

## Validation

```powershell
npm run typecheck
npm run lint
npm test
npm run test:storage
npm run build
```

The SQL integration tests apply the actual migrations to local PostgreSQL-compatible PGlite, including a nonowner runtime role for RLS checks. Tests use fictional records and fake storage; they do not contact AWS, Neon or a mail provider. Cloud-provider end-to-end validation is a separate deployment step.

`npm run test:live-roles` is an opt-in, owner-run multi-connection isolation harness for a real PostgreSQL database (see the [Neon database runbook](docs/neon-database-runbook.md)); it is not part of `npm test` or CI.

With the fictional development server running, `npm run test:local` checks the assembled HTTP routes, workflows and token permissions. It requires the local database flags and `DEV_SEED_PASSWORD`, archives its own fictional records, and revokes its test token. It never targets a remote server.

## Deployment and migration

1. Follow [Vercel and Neon deployment](docs/deployment.md).
   For distinct Preview and Production resources, use [environment isolation](docs/environment-isolation.md).
2. Configure [private S3 storage and Vercel OIDC](docs/s3-setup.md).
3. Review [security and data flows](docs/security.md).
4. Run the [legacy migration](docs/migration.md) in dry-run mode first.
5. Use [API tokens and examples](docs/api-examples.md) for authorised AI integrations, and the [MCP endpoint guide](docs/mcp.md) to connect Claude.ai or Claude Code.

Recruiters can follow the [workspace user guide](docs/user-guide.md). GitHub Actions repeats the local validation commands with fictional data and no deployment credentials.

See [validation results and staging checks](docs/validation.md) for the scope of testing and what remains to verify with live services.

No provider credentials, candidate files, old spreadsheets, databases or production data belong in this public repository. Keep secrets in Vercel's server environment and local `.env.local`; use separate development, preview and production resources.
