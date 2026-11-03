# Security and data flows

RecruitmentOS is a cloud application. Its authorised service connections differ from the earlier offline desktop dashboard. This document describes implemented controls and remaining deployment checks; it is not a guarantee that no vulnerabilities exist.

## Intended connections

| Connection                                                                           | Data and purpose                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Browser → same-origin Next.js `/api/auth/*`, `/api/v1/*`, `/api/settings/*`          | Sign-in, team-scoped recruitment records, personal settings and upload tickets                             |
| Vercel server → Neon PostgreSQL, TLS                                                 | Auth sessions, teams, recruitment facts, personal notes, audit records, token hashes and upload references |
| Browser → configured private S3 bucket                                               | Direct, size/type/key-constrained upload using an expiring signed form; private version-specific download  |
| Vercel server → AWS STS/S3                                                           | OIDC role credentials, versioning/metadata/range checks and download signatures                            |
| Vercel server → Resend                                                               | Account email verification, password resets and team invitations; no CVs or recruitment records            |
| Browser/server → Google or Microsoft                                                 | Only when an administrator configures that optional sign-in provider and the user chooses it               |
| Administrator-run importer → chosen application origin and its signed S3 destination | Only with explicit `--apply`; dry-run reads locally and reports reconciliation                             |

No external AI provider, advertising library, remote font or product analytics service is integrated. API tokens let an independently authorised AI client call this application; the application does not send its records to that client on its own. Next.js anonymous build telemetry is disabled by the project's command wrapper. Dependency installation contacts npm; that is a development operation, not a candidate-data flow.

## Identity and tenancy

- Better Auth handles password hashing, database sessions, verification and reset tokens. Registration is invitation-only unless explicitly opened; a configured bootstrap email can create the initial account. A generic successful registration response may conceal a rejected address to avoid account enumeration. Verification and a live membership are required before accessing team records.
- Optional provider sign-in does not auto-link another account by matching an email. Microsoft email claims are not treated as an invitation or a verified local identity by themselves. Validate actual provider flows in staging.
- Every API request resolves a session or a Bearer token. An invalid Bearer header never falls back to cookie privileges. A team header must match current membership or the token's fixed team.
- Role scopes are checked on the server. Tokens cannot manage accounts, memberships or other tokens. Membership removal/demotion affects subsequent requests; last-owner protection is serialized in the database.
- Business operations run in transactions with local team/user settings and explicit team predicates. Composite foreign keys stop cross-team parent references. Private candidate states, saved views and notification reads have user-level policies.
- Production refuses owner/superuser/BYPASSRLS runtime connections. RLS must be deployed with the separate restricted runtime role; tests exercise a nonowner role locally.

## API and write integrity

Cookie-authenticated writes require the exact configured origin. Auth routes additionally bound input size and reject unexpected origins. No permissive CORS is supplied. JSON bodies are streamed with size limits, domain inputs are strict and bounded, reference kinds are checked, and Drizzle parameterises database values. Arbitrary import URLs, filesystem paths, shell execution and client-owned object keys are not accepted.

Record updates use versions; stale writes return 409. Creation supports actor/team/operation-scoped idempotency keys, rejects different payloads under the same key (even after the key expires), and commits the audit and record change together. Expired idempotency keys never re-run a create: an identical retry reconciles to the original record in the caller's team, or returns 409 `idempotency_expired` when it no longer exists. Bulk vacancy assignment re-runs instead, because active candidate/vacancy pairs are never duplicated. Every error response carries a fresh correlation ID; 500s log only that ID and a safe category (error class and SQLSTATE), never messages, stacks, request data or record contents. Audit history is append-only. Comments are append-only and use the authenticated actor. Personal-note/comment bodies are excluded from audit metadata. Import provenance is explicitly marked and cannot fabricate observed stage changes.

API tokens contain at least 256 random bits; only SHA-256 hashes are stored. The plaintext is shown once. Tokens have an explicit expiry (maximum 365 days), selectable current-role scopes, revocation and database-backed rate limits. Treat a token as a credential: use separate minimal tokens per client, never put them in prompts, repository files, public screenshots, browser URLs or query strings. Rate limits complement provider/project budgets; they are not a complete denial-of-service defence.

## CV handling

S3 objects remain private with public access blocked. The server chooses a team/candidate-scoped key and reserves quota before issuing a short-lived signed POST limited to the exact expected size/type. Validation reads bounded data from an exact object version and stores that VersionId. Downloads are signed for that same version and expire quickly; a replayed upload cannot silently replace the already validated version. Signed URLs are bearer credentials until they expire, so anyone deliberately given one can use it within that period.

Format checks reject obvious type mismatches, malformed/unsafe document archives and excessive expansion. **They are not malware scanning.** PDF/DOC and images can still contain malicious content; production policy may require private quarantine scanning before ready status. Downloads use attachment disposition and an opaque content type. Do not configure automatic noncurrent-version deletion on the CV prefix: ready records can reference older versions. Quota cleanup releases expired database reservations; orphan-object cleanup must be database-aware.

Database quotas bound accepted CVs and pending reservations, rather than every physical S3 version. Replaying a still-valid signed upload form can create additional unreferenced versions. Use provider budget alarms and database-aware orphan cleanup as part of production operations; do not treat the application quota as a hard AWS billing cap.

## Deployment responsibilities and limits

The implementation is locally validated with fictional data and fake cloud clients. Real Neon connectivity/pooling, Vercel OIDC trust, AWS policy enforcement, browser S3 CORS, delivered email, optional OAuth, backup restoration, provider quotas and production observability require staging checks after access is supplied. See [deployment.md](deployment.md), [authentication.md](authentication.md), and [s3-setup.md](s3-setup.md).

Recruitment and token changes have application audit events; authentication/team membership changes do not currently have an equivalent application audit feed. Better Auth's team creation can leave an inaccessible empty organisation if its separate owner-member insertion fails; an administrator should reconcile that exceptional failure before retrying repeated team creation. The CSP restricts sources and framing but still permits framework inline scripts/styles and regional S3 hosts; it is not a nonce-based strict CSP. AWS credentials are explicitly supplied; the AWS SDK may still read optional shared SDK configuration flags in a local environment.

Define organisational retention/deletion, lawful access, offboarding, export handling, malware policy and incident response before importing real CVs. Protect local migration reports and exports as candidate data. This repository intentionally contains no real records, legacy files, service credentials or deployment secrets. Dependencies are locked; review updates and rerun tests before release.
