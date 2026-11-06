<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# RecruitmentOS agent instructions

RecruitmentOS is a team-based recruitment workspace: Next.js App Router, React, strict TypeScript, Better Auth, Drizzle, PostgreSQL (Neon when hosted, PGlite only for explicit local development/tests), private CV storage (selected target: private Vercel Blob; S3 code is legacy) and Resend mail.

## Requirements to read

The product scope and acceptance criteria live in `docs/requirements/`:

- `recruitmentos-brief.md` for context, `recruitmentos-brd.md` for business rules (FR-_, NFR-_), `recruitmentos-srs.md` for engineering requirements (SRS-*) and release gates.
- `docs/requirements/register.md` maps every requirement ID to code, tests and status. Update the rows you touch.

Before touching identity, tenancy, storage or deployment code, also read `docs/security.md`, `docs/identity-boundary-plan.md`, `docs/mcp.md`, `docs/blob-security-design.md`, `docs/blob-quota-design.md` and `docs/environment-isolation.md`.

## Runtime and fresh-checkout setup

- Node.js 24 and npm only (`engines: >=24 <25`). On this Windows machine Node 26 is earlier on PATH: prefix every shell command with `export PATH="/c/Program Files/nodejs:$PATH" &&` and confirm `node --version` prints v24.
- Fresh checkout or worktree: `npm ci`, then copy `.env.local` from the main checkout (`C:/Users/omara/Hermes/RecruitmentOS/.env.local`) into the worktree. Never commit it, and never edit the main checkout's `.env.local`; change only the worktree's copy. It enables the fictional local database (`DATABASE_MODE=pglite`, `ALLOW_LOCAL_DB=true`, `DEV_MAIL_MODE=console`) and already holds a fictional `TENANT_CONTEXT_SIGNING_KEY` (required by `withTeam`, `db:migrate` and PGlite startup). Only for a checkout without one, append a fictional key to that checkout's own `.env.local`: `echo "TENANT_CONTEXT_SIGNING_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")" >> .env.local`.
- Each worktree uses its own PGlite directory: in the worktree's `.env.local` replace the `PGLITE_DATA_DIR` line with `PGLITE_DATA_DIR=.data/pglite` (gitignored), run `mkdir -p .data`, then `npm run db:migrate && npm run db:seed`. Both close the database and exit on their own after printing; the seed prints the fictional login.
- Worktree paths are native Windows paths (`C:/Users/...`). Never pass `/c/Users/...` to `git worktree add` or other native tools; that creates a stray `C:/c/Users/...` folder.
- Before finishing, stop every dev server, seed and other node process you started.

## Dev server

`npm run dev -- --port <port>` serves `http://127.0.0.1:<port>`. Start it in the background, wait for the port, stop it when done. Sign in with the fictional seed account. Use the `agent-browser` CLI for pages (`agent-browser skills get core` first); it lives under `C:/Users/omara/AppData/Local/hermes/tools/agent-browser-0.26.0-win32-x64/bin/`.

## Validation commands

Run all of these for the areas you change; they must pass:

```
npm run typecheck
npm run lint            # or: npx eslint <changed files>
npm test                # vitest, PGlite SQL integration tests (~2-3 min)
npm run test:storage    # node --test storage suites
npm run build
npm run format:check    # prettier; format only the files you changed
```

`npm audit --audit-level=moderate` also runs in CI. Never run a repo-wide `--fix` or `prettier --write .`.

## Non-negotiable rules

- Fictional data only. Never add real candidate records, CVs, the owner's personal CV, credentials, database dumps or private reports to the repository, tests, logs or screenshots.
- Do not weaken, remove or flag-bypass a security guard (for example the hosted runtime role and connection checks in `createDbPair()`, the hosted sign-in readiness checks in `getAuthOptions()`, Blob disablement) to make something work. A guard is removed only by completing and testing the control it protects.
- No silent provider fallback (Blob to S3), no fake success responses, no decorative controls for disabled features.
- Never deploy, push, change Vercel/Neon/Blob/Resend settings, create credentials or send email. The orchestrator does release work.
- Never run `scripts/blob-live-verify.ts`, with or without `--confirm-live-preview-blob`: only the owner runs it, against the Preview Blob store.
- Run `npm run test:live-roles` only against a throwaway local PostgreSQL cluster in the worktree `.data` folder on a non-default port, never against Neon or any remote database. A throwaway transaction-mode pooler (for example PgBouncer) for this harness is allowed only in the worktree `.data` folder, on a non-default port, never installed as a system service, and must be stopped and deleted afterwards.
- Keep missing facts unknown; no ranking, suitability scores, sensitive-trait inference or automatic hiring decisions.
- Match the existing code style; keep changes the smallest that fully meet the spec. Commit with short one-line messages, staging explicit paths.
