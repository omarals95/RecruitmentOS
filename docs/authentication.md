# Authentication and team setup

> **Hosted sign-in opens only behind the readiness checks below, and release still needs the owner's decision.** Code no longer blocks hosted sign-in outright; it stays unavailable unless every condition in [Hosted sign-in readiness](#hosted-sign-in-readiness) holds. Live Vercel behaviour, Resend delivery and HTTPS cookies on a real deployment are unverified. See [identity-boundary-plan.md](identity-boundary-plan.md) for the remaining verification.

RecruitmentOS uses Better Auth with database-backed sessions, verified email/password sign-in, and team invitations. A team is a Better Auth organization. Candidate data is protected by additional live membership and permission checks on every request.

## Configuration

Set these server-only values in the deployment environment:

| Variable                | Purpose                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL`       | Exact HTTPS application origin, with no path. Local development accepts localhost/127.0.0.1 HTTP.               |
| `BETTER_AUTH_SECRET`    | Random secret of at least 32 characters. Keep stable across deployments.                                        |
| `DATABASE_URL`          | Runtime PostgreSQL connection, using the separate restricted runtime role described in deployment instructions. |
| `IDENTITY_DATABASE_URL` | Separate restricted identity connection to the same database; the role design is not yet deployment-ready.      |
| `RESEND_API_KEY`        | Transactional email delivery credential.                                                                        |
| `EMAIL_FROM`            | Verified sender, for example `RecruitmentOS <recruitment@example.org>`.                                         |
| `BOOTSTRAP_OWNER_EMAIL` | Email allowed to create the first administrator account without an invitation. It still must be verified.       |
| `BOOTSTRAP_SETUP_TOKEN` | Random, secret base64url token generated from at least 32 random bytes, unique to each environment.             |
| `ALLOW_PUBLIC_SIGNUP`   | Default false. Set exactly `true` only to intentionally allow public account registration.                      |

The public website remains accessible when configuration is incomplete. Sign-in pages show setup-required state. Private operations fail closed; the app never substitutes fake production users or a local database.

## Hosted sign-in readiness

A process is hosted when `NODE_ENV=production` or `VERCEL` is set. `getAuthOptions()` in `src/lib/auth.ts` reports hosted sign-in configured only when all of these hold; otherwise sign-in pages show setup-required, `getAuth()` and the auth route return 503 `AUTH_NOT_CONFIGURED`, and API tokens are refused. Which condition failed is never shown or logged.

- **H1:** `NODE_ENV=production` and `VERCEL=1`. A hosted process outside the Vercel production runtime (self-hosted, `vercel dev`) stays unavailable.
- **H2:** `BETTER_AUTH_URL` is an `https:` URL that is exactly its origin (an optional trailing `/` only; no path, query, fragment or credentials). Plain `http:` is refused when hosted, including localhost.
- **H3:** `BETTER_AUTH_SECRET` is usable: at least 32 characters, no whitespace, not one repeated character and not a placeholder.
- **H4:** `DATABASE_URL` and `IDENTITY_DATABASE_URL` are both set and pass `prepareConnectionTargets()`: the same host, port and database, a username and password in each, at most a single `sslmode=require|verify-full` parameter, and no non-empty `PGOPTIONS`.
- **H5:** `DATABASE_MODE` is not `pglite` and `ALLOW_LOCAL_DB` is not `true`.
- **H6:** `DEV_MAIL_MODE` is not `console` and `DEV_SEED_PASSWORD` is unset or empty.
- **H7:** `TENANT_CONTEXT_SIGNING_KEY` is canonical base64url of at least 32 bytes.
- **H8:** `RESEND_API_KEY` and `EMAIL_FROM` are both set. Console mail never counts when hosted.
- **H9:** the check reads only the environment: it contacts no service and opens no pool. H4 to H7 reuse `prepareDbPairTargets()` in `src/db/index.ts`, the same synchronous refusals `createDbPair()` runs before it creates a pool. The connection-time role, marker, boundary and storage-schema checks still run at first database use and still fail closed with 503.

`ALLOW_UNSAFE_TENANT_ISOLATION` has no effect. Local (non-hosted) readiness is unchanged: HTTP localhost/127.0.0.1, PGlite with `ALLOW_LOCAL_DB=true`, and console mail count. The bootstrap variables are not part of readiness; `/create-admin` reports separately when they are missing.

## Client IP, API tokens and the invalid-token budget

`src/lib/client-ip.ts` resolves one client IP for both Better Auth and the API. On Vercel (`VERCEL=1`) it reads only `x-vercel-forwarded-for`; elsewhere (local development and tests only, since H1 makes hosted sign-in Vercel-only) only `x-forwarded-for`. The value must be a single valid IPv4 or IPv6 address (IPv6 collapsed to /64, Better Auth's own parsing). A missing, multi-valued or invalid value means no client IP; `x-forwarded-for` on Vercel, `x-real-ip`, `forwarded` and the first value of a list are never used. Better Auth's `advanced.ipAddress.ipAddressHeaders` is set to the same header, so its database-backed auth rate limits and session addresses use the same client IP.

API tokens are refused with 503 `AUTH_NOT_CONFIGURED` wherever sign-in readiness is false, locally too, before any format check or identity-database access. An `Authorization` header never falls back to session auth. A malformed token is a 401 `invalid_token` without database access. Each well-formed token that fails (unknown, revoked, expired, unverified user or non-member) uses one unit of the client's budget, stored in `auth.api_rate_limits` as `api-guess:<client IP>` (or `api-guess:no-client-ip`). After 10 failed attempts in a 60-second window, every token from that client, valid or not, gets 429 `token_guess_rate_limited` with `Retry-After: 60` before the token lookup, without touching any per-token counter or `last_used_at`. The check holds the budget row lock in the identity transaction, and refused attempts commit before the error is thrown. Successful authentications leave the budget unchanged; the 60 per minute per-token limit is unchanged.

## Local development

For explicit local development only, use `DATABASE_MODE=pglite`, `ALLOW_LOCAL_DB=true`, and an optional `PGLITE_DATA_DIR`. `DEV_MAIL_MODE=console` prints local verification/reset/invitation messages to the development terminal. Never use this with real accounts or share the terminal output. Console mail is disabled in production and whenever Vercel hosting is detected. Local and production authentication have the same verification requirements.

## First account and invitations

1. Apply all database migrations and configure the bootstrap email, a unique setup token, and mail sender. Keep the token in the deployment secret store and provide it to the intended administrator through a secure channel. Generate it locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`; never commit it or place it in a URL.
2. Open `/create-admin` and provide the exact bootstrap email, name, password and setup token. Open the verification email and sign in. The token alone does not verify the email. The first team created by this verified account gives it the owner role.
3. Open Team settings, create a team, and invite colleagues with their intended role.
4. Each colleague creates an account using the invited email, verifies it, signs in, and accepts the invitation link. An existing verified account can accept directly.

Registration is invite-only by default. For privacy, the auth library can return a generic successful signup response even when registration is denied or the account already exists. An unsolicited attempt does not create a user or send mail. Invitations expire after 48 hours. A user can create at most five teams; a database guard enforces the cap. The final team owner cannot be removed or demoted, including simultaneous database operations.

Setup is claimed once per database in the same transaction as the initial user insert, with an advisory transaction lock and a durable claim that remains after deletion. It remains pending until the designated user verifies their email and creates a team in which they are the owner; other account registrations are blocked until then. A migration marks deployments with existing users or teams as already initialized. If delivery fails, use the verification page to resend the email for the existing account; if account creation rolled back, retry the setup. A database outage or missing setup configuration fails closed. No automatic reset is provided; an operator must investigate and explicitly handle any exceptional recovery. Preview and production require separate databases, secrets, setup tokens and email addresses where appropriate.

Roles are owner, admin, recruiter, and viewer. Only owners can grant or change ownership. Recruiter/viewer roles do not administer team memberships. Unknown or combined role strings are rejected. Personal API tokens use a separate scope policy and cannot administer authentication or teams.

## Optional providers

Google requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with callback `${BETTER_AUTH_URL}/api/auth/callback/google`. Google must report a verified email.

Microsoft requires `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`; optionally set `MICROSOFT_TENANT_ID` to restrict the tenant. Callback: `${BETTER_AUTH_URL}/api/auth/callback/microsoft`. Microsoft identity uses its provider identifier, and its email claim is not treated as proof of email ownership. New Microsoft accounts must complete local email verification before any private team action. Do not grant access based on an email domain alone.

Provider buttons appear only when their credentials are configured. Existing local accounts are never silently linked to OAuth identities by email. A signed-in user can explicitly link a provider only using the library's protected account-linking flow. OAuth callback and provider email behavior need staging checks with configured test accounts before enabling them for production use.

## Security behavior and validation

Authentication writes require the exact app Origin; OAuth callback routes retain Better Auth's state checks. Trusted origins do not include wildcard Vercel preview domains. Database session caching is disabled, so revocation does not wait for a cached cookie expiry. Password reset revokes existing sessions. A session's active-team field is a selection preference; data routes still check live membership.

Auth HTTP rate limits persist in PostgreSQL. Direct server `auth.api` calls do not receive those HTTP limits, so do not add custom unauthenticated sign-in proxy endpoints without their own throttling. API bearer tokens have a separate durable limiter.

Local tests exercise the real SQL migration and Better Auth handler using fictional accounts, a disposable PGlite database, a restricted identity role, and an in-memory mail sink. They verify invite-only registration, email verification, password reset revocation, invitation email matching, role restrictions, cross-origin rejection, creator spoof prevention, team caps, and last-owner database guards. `tests/auth-lifecycle.test.ts` and `tests/auth-oauth.test.ts` add:

- atomic team creation: a failed owner-member insert leaves no team, slug or used team allowance, keeps initial setup pending, and a retry creates exactly one owned team;
- simultaneous bootstrap sign-ups create one administrator and one claim, and no other account while setup is pending;
- the sign-in, sign-up, password-reset and verification-resend rate limits (429 per client address, no mail for refused requests);
- expired and tampered verification links, a reused verification link, and reused or expired reset tokens;
- reset links and callback URLs bound to each environment's origin;
- identical responses for existing and unknown accounts on reset, verification resend, sign-up and sign-in;
- sign-out, single-session revocation, revoking other sessions, and password change with session revocation;
- cancelled and expired invitations, which can neither be accepted nor used to register;
- admins cannot promote themselves or others to owner, demote or remove an owner, or invite an owner;
- simultaneous mutual removal or demotion of two owners keeps an owner;
- provider buttons only when both credentials are set, and Google/Microsoft callbacks (with a stubbed provider endpoint) that never link an existing account by email, never register an uninvited email, and never let an unverified provider email accept an invitation.

`tests/auth-readiness.test.ts` covers the hosted-ready baseline and one refusal per readiness condition; `tests/client-ip.test.ts` the header rules and a Better Auth sign-in limit that rotating spoofed headers cannot reset; `tests/api-token-gate.test.ts` the token gate and the invalid-token budget through an API route; and `tests/hosted-auth-links.test.tsx` the `/create-admin` setup form and bootstrap verification link under hosted readiness (with `fetch` stubbed) plus `__Secure-` `Secure`, `HttpOnly`, `SameSite=Lax` cookies and invitation and reset links on an HTTPS origin.

No actual mail, OAuth provider, or cloud credential is used, and the races run on a single PGlite connection. Hosted client-IP resolution is implemented from `x-vercel-forwarded-for`, but live Vercel header behaviour, Resend delivery and HTTPS cookies on a real deployment remain unverified. External delivery, Neon pool behavior, live OAuth clients and redirects, and multi-connection PostgreSQL races require deployment-stage verification.
