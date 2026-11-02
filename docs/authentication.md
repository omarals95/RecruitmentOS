# Authentication and team setup

RecruitmentOS uses Better Auth with database-backed sessions, verified email/password sign-in, and team invitations. A team is a Better Auth organization. Candidate data is protected by additional live membership and permission checks on every request.

## Configuration

Set these server-only values in the deployment environment:

| Variable                | Purpose                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL`       | Exact HTTPS application origin, with no path. Local development accepts localhost/127.0.0.1 HTTP.               |
| `BETTER_AUTH_SECRET`    | Random secret of at least 32 characters. Keep stable across deployments.                                        |
| `DATABASE_URL`          | Runtime PostgreSQL connection, using the separate restricted runtime role described in deployment instructions. |
| `RESEND_API_KEY`        | Transactional email delivery credential.                                                                        |
| `EMAIL_FROM`            | Verified sender, for example `RecruitmentOS <recruitment@example.org>`.                                         |
| `BOOTSTRAP_OWNER_EMAIL` | Email allowed to create the first administrator account without an invitation. It still must be verified.       |
| `ALLOW_PUBLIC_SIGNUP`   | Default false. Set exactly `true` only to intentionally allow public account registration.                      |

The public website remains accessible when configuration is incomplete. Sign-in pages show setup-required state. Private operations fail closed; the app never substitutes fake production users or a local database.

For explicit local development only, use `DATABASE_MODE=pglite`, `ALLOW_LOCAL_DB=true`, and an optional `PGLITE_DATA_DIR`. `DEV_MAIL_MODE=console` prints local verification/reset/invitation messages to the development terminal. Never use this with real accounts or share the terminal output. Console mail is disabled in production. Local and production authentication have the same verification requirements.

## First account and invitations

1. Configure the bootstrap email and mail sender.
2. Create an account using the exact bootstrap email, then open the verification email and sign in.
3. Open Team settings, create a team, and invite colleagues with their intended role.
4. Each colleague creates an account using the invited email, verifies it, signs in, and accepts the invitation link. An existing verified account can accept directly.

Registration is invite-only by default. For privacy, the auth library can return a generic successful signup response even when registration is denied or the account already exists. An unsolicited attempt does not create a user or send mail. Invitations expire after 48 hours. A user can create at most five teams; a database guard enforces the cap. The final team owner cannot be removed or demoted, including simultaneous database operations.

Roles are owner, admin, recruiter, and viewer. Only owners can grant or change ownership. Recruiter/viewer roles do not administer team memberships. Unknown or combined role strings are rejected. Personal API tokens use a separate scope policy and cannot administer authentication or teams.

## Optional providers

Google requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with callback `${BETTER_AUTH_URL}/api/auth/callback/google`. Google must report a verified email.

Microsoft requires `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`; optionally set `MICROSOFT_TENANT_ID` to restrict the tenant. Callback: `${BETTER_AUTH_URL}/api/auth/callback/microsoft`. Microsoft identity uses its provider identifier, and its email claim is not treated as proof of email ownership. New Microsoft accounts must complete local email verification before any private team action. Do not grant access based on an email domain alone.

Provider buttons appear only when their credentials are configured. Existing local accounts are never silently linked to OAuth identities by email. A signed-in user can explicitly link a provider only using the library's protected account-linking flow. OAuth callback and provider email behavior need staging checks with configured test accounts before enabling them for production use.

## Security behavior and validation

Authentication writes require the exact app Origin; OAuth callback routes retain Better Auth's state checks. Trusted origins do not include wildcard Vercel preview domains. Database session caching is disabled, so revocation does not wait for a cached cookie expiry. Password reset revokes existing sessions. A session's active-team field is a selection preference; data routes still check live membership.

Auth HTTP rate limits persist in PostgreSQL. Direct server `auth.api` calls do not receive those HTTP limits, so do not add custom unauthenticated sign-in proxy endpoints without their own throttling. API bearer tokens have a separate durable limiter.

Local tests exercise the real SQL migration and Better Auth handler using fictional accounts, a disposable PGlite database, and an in-memory mail sink. They verify invite-only registration, email verification, password reset revocation, invitation email matching, role restrictions, cross-origin rejection, creator spoof prevention, team caps, and last-owner database guards. No actual mail, OAuth provider, or cloud credential is used. External delivery, Neon pool behavior, OAuth redirects, HTTPS cookies, and multi-connection PostgreSQL races require deployment-stage verification.
