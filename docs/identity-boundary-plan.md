# Identity and tenant boundary: implementation plan

**Implemented and Preview verified, not deployed.** Migration `0006_trusted_tenant_context.sql` replaces the GUC-based tenant policies with a signed per-transaction context (see [Signed tenant context](#signed-tenant-context)). It was tested on PGlite with synthetic nonowner roles and on a throwaway local PostgreSQL 18 cluster. In the owner's run on the Neon Preview database, the role template is applied, `scripts/db-role-evidence.ts` passes with zero drift, and `npm run test:live-roles` passes 27/27 through the transaction-mode pooler and 27/27 direct, with all fixtures removed. It has not been independently reviewed (DEC-02/DEC-03) or verified on Production. Blob CV storage remains disabled. No role, credential or hosted database is changed by this document. The Production Marketplace resource's database contents and effective privileges have not been verified. Confirm them before any mutation.

The first staged code introduces separate data and identity pool interfaces and migration `0005_database_connection_marker.sql`, which creates an owner-controlled per-database marker. The two runtime roles would need read-only access to that marker; neither may alter it. Matching the endpoint and marker helps detect mismatched pools but does not prove environment separation when a database has been cloned or incorrectly configured. The legacy shared-role fixture has been removed. [postgres-split-runtime-roles.sql](../infrastructure/postgres-split-runtime-roles.sql) creates the `recruitmentos_data` and `recruitmentos_identity` roles with exact object-by-object grants (WP-02a). It is verified on PGlite, on a throwaway local PostgreSQL 18 cluster and, in the owner's run, on the Neon Preview database, where it is applied and `scripts/db-role-evidence.ts` passes with zero drift. It has not been verified on Production.

Hosted and `NODE_ENV=production` database startup (`createDbPair()` in `src/db/index.ts`) has no blanket block (WP-02e). It fails closed on precise checks, with no environment-variable override, before serving any request:

- `DATABASE_MODE=pglite` or `ALLOW_LOCAL_DB=true`: 503 `local_db_disabled`.
- `DEV_MAIL_MODE=console` or any `DEV_SEED_PASSWORD`: 503 `development_setting_refused`.
- A missing or malformed `TENANT_CONTEXT_SIGNING_KEY`: 503 `tenant_context_unavailable`.
- A missing `DATABASE_URL` or `IDENTITY_DATABASE_URL`, URLs for different endpoints or databases, missing credentials, any URL parameter other than one `sslmode=require|verify-full`, or a non-empty `PGOPTIONS`: 503 `unsafe_database_connections`, before any pool exists.
- Non-loopback pools always use `sslmode=verify-full` with certificate verification.
- A session login that differs from the effective role, or an unsafe result from the runtime role safety query (elevated attributes, broad `pg_*` roles, protected-object ownership, ownership of the current database, database `CREATE`/`TEMPORARY`, grant options, `public` schema access) or the marker and per-role boundary queries: 503 `unsafe_database_role`.
- A missing connection marker, the same effective role on both pools, mismatched markers, or a role able to assume the other: 503 `unsafe_database_connections`.
- A missing or different storage schema version: 503 `storage_schema_mismatch`.

Any failure ends both pools. Startup checks only that the signing key is set and well formed: an uninstalled or retired key is rejected per transaction by `tenant_context.install` (403 `tenant_context_denied`), because the runtime roles cannot read `tenant_context.keys`. Hosted sign-in opens only through the readiness checks in `getAuthOptions()` ([authentication.md](authentication.md#hosted-sign-in-readiness)), and Blob CV storage stays disabled. The role-boundary checks forbid callable non-system security-definer functions and accessible views/foreign tables, except an exact per-role allowlist of `tenant_context` helpers (`src/db/connection-boundary.ts`). The data role's list includes `tenant_context.lock_storage_allocation(text,text,text)`, which locks the CV storage ledger rows for the context's team (migration `0007`), and the Blob read-lease helpers `tenant_context.acquire_blob_read(text)` and `tenant_context.release_blob_read(uuid)`, which take and release a cross-instance provider read lease for the context's team only (migration `0009`). A helper is allowlisted only when the `tenant_context` schema owner owns it and its `search_path` is fixed to exactly `pg_catalog, pg_temp` (temporary objects last). Local synthetic tests do not establish a completed SQL-compromise boundary.

## Security objective and limit

Prevent a caller with arbitrary SQL execution **on the recruitment-data database role** from changing authentication state, minting an accepted API token, impersonating a different team in a quota operation, or reading another tenant's recruitment data. This is defense against a compromised SQL access path, not compromise of the application process, trusted identity service, signing key, database owner or operator. It also does not establish that any public SQL injection exists.

Synthetic local tests reproduced both team-context forgery and authentication using a token inserted by the shared runtime SQL role; they did not use real candidate data or demonstrate an exposed HTTP exploit. Two distinct changes were necessary. Separating identity writes blocks the token-minting signer oracle. Every protected data path now also derives team, actor and access from a verified per-transaction assertion instead of `app.team_id`/`app.user_id`. A future quota command still needs its own signed command design (item 5). Do not claim strict isolation until the design is independently reviewed and tested on live connections.

## Current operations that must keep working

- `src/db/index.ts` has staged `getDb()` and `getIdentityDb()` pool interfaces. In local single-pool development they still share one database. Better Auth and first-admin status use the identity interface; the adapter reads and mutates `auth.user`, `account`, `session`, `verification`, `rate_limit`, `organization`, `member` and `invitation`. Its hooks also read membership and handle initial setup, organization ownership and invitations. Bootstrap and the migration-owned marker triggers must still work with the restricted identity role.
- `src/lib/api-tokens.ts` routes token authentication, listing, creation and revocation through the identity interface. `createToken()` and `revokeToken()` run in **one** identity-role transaction. `liveHuman()` locks the user row and enforces the 50-token cap. The transaction then installs a signed context, changes `auth.api_tokens` and calls `tenant_context.audit_token()`, which inserts the `token.created` or `token.revoked` activity row in the same transaction. Neither function uses the data pool.
- `src/lib/principal.ts` reads membership; `src/lib/workspace.ts` reads membership and organization for team selection. `listActivity()` in `src/lib/insights.ts` no longer joins `auth.user`. It calls `tenant_context.activity_actor_name()` for display names and name search. The data role has no `auth` access.
- The MCP OAuth server (WP-16, migration `0010_mcp_oauth.sql`) adds three identity tables: `auth.oauth_clients`, `auth.oauth_codes` and `auth.oauth_tokens` (hashes only). The identity role gets `SELECT, INSERT` on clients and `SELECT, INSERT, UPDATE` on codes and tokens, and no `DELETE`; the data role gets nothing on them. An approved consent is an `auth.api_tokens` grant row with `oauth_client_id` set, created by `createOAuthGrant()` in the same identity transaction pattern as `createToken()` (`liveHuman()`, the 50-token cap, `installTenantContext` and `audit_token(id, 'token.created')`). An OAuth principal is `authType: "token"` with the grant's id as `tokenId`, so `tenant_context.install` checks it exactly like an API token, unchanged. `authenticateApiToken` ignores grant rows; only their access tokens authenticate, and only at `/api/mcp`. When a reused code or refresh token revokes a grant, the token endpoint's identity transaction (which holds no context) calls `tenant_context.audit_grant_reuse()` (migration `0011`, see [OAuth reuse audit](#oauth-reuse-audit)). The identity role may execute exactly three helpers: `tenant_context.install`, `tenant_context.audit_token` and `tenant_context.audit_grant_reuse` (`identityRoleHelpers` in `src/db/connection-boundary.ts`).
- `withTeam()` in `src/lib/db-team.ts` opens a data-pool transaction. Its first statement reads the backend pid, transaction id, connection marker and database clock; its second installs one signed assertion. It sets no GUCs. Application filters stay as defence in depth.

## Proposed privilege separation

1. In **each** environment use independent credentials and pools for (a) a restricted identity role and (b) a nonowner recruitment-data role. Neither role may inherit, assume or obtain the other, the migration owner, `neon_superuser` or broad built-in data roles. Neon roles created through the Console/API/CLI may be granted `neon_superuser`; use a reviewed SQL provisioning method and verify effective attributes, membership, default ACLs and ownership. Do not print or commit passwords or connection strings.
2. Route Better Auth and account/session/team operations to the identity role. Route principal and API-token authentication through controlled identity access. Grant only operations verified necessary for the Better Auth adapter and token lifecycle, rather than `ALL TABLES IN SCHEMA auth`; deny direct access to setup-marker writes except through the reviewed owner-controlled trigger functions. Identity-role access to recruitment tables must be denied, except for the narrowly defined activity/audit write required below. This role remains powerful over identity; it must be isolated from the recruitment-data SQL path.
3. Route `withTeam()` recruitment operations to the data pool. Deny data-role identity mutations including token, session, user, account, member and invitation inserts, updates and deletes, both directly and through inherited or public grants. Restrict identity reads to the reviewed minimum; avoid exposing password hashes, token hashes, session tokens and other teams' identity information. Adapt create-admin, team selection, principal resolution and the activity-name join explicitly instead of preserving broad auth-table access.
4. **Implemented locally.** Token audit uses a same-transaction identity-side helper rather than an outbox (the DEC-03 choice; see [Token audit](#token-audit)). Token create/revoke and the append-only activity insert commit or roll back together in the identity-role transaction. The identity role gets no `app` table grants. The row passes FORCE RLS on `app.activity` because the transaction holds a verified signed context. Concurrent cap enforcement keeps the `liveHuman()` row lock. Multi-connection races are still unverified.
5. Only after the identity boundary is in place, design the quota operation. A candidate is a short-lived, domain-separated signed command generated by a trusted signer after validating the real session or API token, current membership and `cvs:write`. Bind environment, store, team, principal, auth type and token identity/scope, candidate, ticket/path, maximum size/type, expiry, nonce and idempotency fields; the database must act only on the verified payload. Protect verification keys from the data role; enforce atomic nonce/retry behavior, store/team locks and durable charges. The signer, its identity-state source, credential ownership, revocation timing, log redaction, rotation, TLS and function grants require independent review. An HMAC added to the current shared-role design is insufficient because that role can currently mint the token used to obtain a legitimate assertion. Alternatively, a separately authenticated quota role and service may use narrowly scoped grants after independently verifying the real identity and token scope; it must not be assumable by the data role, and a service accepting caller-selected identities without independent verification recreates the same flaw. Separate roles and processes add credentials, connections and operational complexity and are a candidate design, not a verified fix.

   **Local ledger (WP-04), pending review.** Migration `0007` does not use a separately signed quota command. `tenant_context.lock_storage_allocation(provider, environment, store)` requires the verified per-transaction context with `cvs:write` and charges only that context's team. It also releases expired S3 reservations on the same bucket for every team, so one team's abandoned tickets cannot hold the shared budget; it changes no amounts, only moves those tickets to `rejected`. Owner-run triggers on `app.uploads` then take the charge from the upload row itself, never from caller arguments. The context already binds team, actor, scopes and database. Nonces, a separate quota role and live verification are not implemented.

6. **Implemented locally.** All seven `app` tables (`records`, `candidate_states`, `activity`, `uploads`, `storage_usage`, `idempotency`, `notification_reads`) keep FORCE RLS with context-derived policies. Every `USING` and `WITH CHECK` expression calls an owner-controlled predicate. The predicate finds the verified context for the current backend and transaction and ignores every GUC. Migration `0007` adds `ledger_owner_read` and `ledger_owner_update` on `app.uploads` and `app.storage_usage`, which match only when `current_user` is the `tenant_context` owner (inside the owner-run ledger helper and triggers); they never match a runtime role.
   - Reads need a context for the row's team.
   - Writes, including `SELECT … FOR UPDATE`, also need a write scope (see [Coarse write gate](#coarse-write-gate)).
   - Private rows also need the context actor: `candidate_states.user_id`, `notification_reads.user_id`, saved-view `records.private_owner_id`, and `personal_state_updated`/`saved-view` activity. Candidate activity needs `candidates:read`.
   - A new activity row must name the context actor (`tenant_context.allows_event`). A `session` row carries no token id, a `token` row carries the context's own token id, and an `import` row needs `imports:write`. A caller therefore cannot forge an event under another member's id or plant one to read a user's name through `activity_actor_name`, which only resolves events the context may read.
   - Replay, rollback and pooling rules are below.

   A database principal or owner capable of changing policies or functions remains trusted.

## Signed tenant context

### Chosen mechanism and rejected alternative

**Chosen: a signed per-transaction assertion.** Each data transaction carries one HMAC-SHA256 signed assertion. An owner-controlled `SECURITY DEFINER` function, `tenant_context.install(payload, signature)`, verifies it and stores the claims in an owner-only context table keyed by backend pid and transaction id. Policies read only that row.

**Rejected: per-principal or per-team database roles.** Every user or team would need its own role and credential. Pooled serverless connections would need a role switch per request, which the data role must not be able to do freely. Role grants would also have to track every membership change.

**Tradeoffs.** The signed design keeps one data pool, reuses the reviewed research fixtures and behaves the same on PGlite and PostgreSQL. Its costs are a signing key the application must protect, definer functions and an allowlist that need review, and two extra statements per transaction.

### Threat model and limit

The design covers arbitrary SQL on the recruitment-data role: forging settings, calling helpers directly, reading other teams' rows or other users' private rows, replaying assertions and reusing pooled connections. The application process, the signing key, the identity role and the database owner are trusted. Anyone holding the key or owner access can mint or bypass contexts.

### Payload fields

The application builds canonical JSON with these fields in this order, signs it with `TENANT_CONTEXT_SIGNING_KEY`, and passes the payload and the hex signature as bind parameters.

| Field    | Meaning                                                                |
| -------- | ---------------------------------------------------------------------- |
| `aud`    | Fixed domain-separation string `recruitmentos-tenant-context-v1`       |
| `kid`    | Key id: the first 16 hex characters of the SHA-256 of the key bytes    |
| `env`    | `db_boundary.connection_marker.id` of the target database              |
| `pid`    | `pg_backend_pid()` of this connection                                  |
| `xid`    | `pg_current_xact_id()` (xid8) of this top-level transaction            |
| `team`   | Team id (bounded identifier)                                           |
| `actor`  | User id (bounded identifier)                                           |
| `auth`   | `session` or `token`                                                   |
| `token`  | Token id when `auth` is `token`; `null` for `session`                  |
| `scopes` | Effective scopes: a subset of the seven known scopes, in a fixed order |
| `exp`    | Expiry in epoch milliseconds, computed from the database clock         |

`install` first checks the size (at most 2048 bytes) and verifies the signature with a known, unretired key, before it reads any identity state. It then requires all of the following:

- the canonical encoding and the exact field set;
- the audience and the environment marker;
- the current pid and xid;
- bounded identifiers, and a token id exactly when `auth` is `token`;
- known scopes;
- an expiry in the future and no more than 60 seconds ahead;
- no existing context for this pid and xid.

Under `FOR SHARE` locks it then rechecks that the user is email-verified and a current member of the team, and that the asserted scopes fit the member's current role. For a token it also checks that the token belongs to that user and team, is unrevoked and unexpired, and stores every asserted scope.

Every rejection raises SQLSTATE `42501` with the single message `Tenant context rejected`. `withTeam` maps that to `403 tenant_context_denied`. A missing or short key raises `503 tenant_context_unavailable` before any database call.

### Replay, savepoint and pool rules

- The assertion is bound to pid and xid8, and an xid8 is never reused. A later transaction on a pooled connection therefore has a different xid and sees no context, and a committed assertion cannot be installed again.
- `withTeam` installs exactly once, as the first statement after the snapshot query, and creates no savepoint before it. `ROLLBACK TO SAVEPOINT` only undoes work done after a savepoint, so it cannot remove the context.
- A second assertion for the same xid is rejected while the first exists, even a validly signed one for another team. Re-installing the same assertion is rejected and leaves the context unchanged.
- The signer never issues two assertions for one transaction.
- A full rollback ends the xid and discards its context row.
- `install` purges expired context rows, at most 100 per call, so the table cannot grow without limit.
- **Transaction pooling (WP-02d).** These rules hold behind a transaction-mode pooler such as Neon's PgBouncer. The context is read and installed inside the transaction, keyed by that transaction's backend pid and xid8. The setup lock is transaction-scoped (`pg_advisory_xact_lock`), and the ledger and lease locks are row locks. The application keeps no session state. The pooler pins one backend for a whole transaction, so a later transaction gets a different xid on whichever backend it runs, and never sees the earlier context. On the Neon Preview pooler, 6 of 27 live checks failed (direct endpoints: 27/27). Locally, behind PgBouncer in `pool_mode = transaction`, the same six failed in the backend-identity and lock-overlap conditions only. The cause was a harness assumption, not an application defect: the harness read backend pids in autocommit statements outside the transactions it checked. With in-transaction pid reads, the harness passed 27/27 through the pooler, locally and then in the owner's Neon Preview run (27/27 through the transaction-mode pooler and 27/27 direct, with all fixtures removed). Pooler requirements are in [neon-database-runbook.md](neon-database-runbook.md#4-connection-pooler-requirements).

### Expiry and revocation timing

Expiry is at most 60 seconds after the database `clock_timestamp()` read by the first statement, so application clock skew and fake test timers do not matter. Predicates compare against `clock_timestamp()` on every evaluation, so an assertion stops granting access mid-transaction once it expires.

`install` rechecks membership, verification and token state under `FOR SHARE` locks. A revocation or membership removal that commits before `install` is enforced immediately. One that commits afterwards takes effect at the next transaction.

### Key storage, rotation and retirement

- **Where the key lives.** In the server-only `TENANT_CONTEXT_SIGNING_KEY` environment variable (base64url, at least 32 random bytes), and as precomputed HMAC inner and outer pads in the owner-only `tenant_context.keys` table. Neither runtime role can read that table. The key, pads, payload and signature are never placed in a setting, logged, returned or written to activity.
- **Per environment.** Each environment needs its own key. There is no default, generated or fallback key in any mode.
- **Installation.** `npm run db:migrate` (owner connection) and local PGlite startup upsert the configured key by key id. A missing key fails with a message that names the variable and shows no value.
- **Rotation.** Set the new key in the environment, run `npm run db:migrate` so its pads are installed, deploy, then retire the old key.
- **Retirement.** An operator SQL step as the owner: `UPDATE tenant_context.keys SET retired_at = now() WHERE id = '<old key id>';`. Retired keys are rejected immediately.
- **Bearer value.** An assertion is a bearer value, but it is bound to one backend and one in-flight transaction for at most 60 seconds and cannot be installed twice.
- **Statement logging.** Statement or bind logging on the owner connection during key installation would record the pads, so disable it for that step. Runtime bind logs could record assertions; they are short-lived and single-use but should still be excluded.
- **No constant-time claim.** The signature comparison is ordinary text equality in PL/pgSQL.

### Coarse write gate

Database writes need any one of `candidates:write`, `recruitment:write`, `cvs:write` or `imports:write`. Per-kind gating would break existing cross-kind `SELECT … FOR UPDATE` locks, for example an application locking its candidate. Viewers and read-only tokens are still denied every write except their own notification read markers. The application's `permission()` and `requireScope()` checks enforce the exact per-resource scopes.

### Token audit

`tenant_context.audit_token(token_id, event)` runs in the caller's identity transaction, which must hold a verified session context. It enforces these rules:

- It derives team, token id, prefix and scopes from the `auth.api_tokens` row as seen in that transaction.
- The action must match the token state, and at most one event of each action may exist per token.
- Create needs the token owner. Revoke needs the token owner or a current team owner or admin.
- The summary and metadata match the earlier application inserts.

Only this owner-run helper may insert `api-token` activity rows: the general write policy excludes that kind for every context, write scope or not. A data-role caller therefore cannot forge token events or pre-insert a `token.revoked` row that would make the helper reject a later real revocation. The helper also covers contexts without a write scope, such as a viewer's read-only token. A transactional outbox was not chosen because it would delay audit visibility and need delivery and retry semantics.

### MCP tool audit

`tenant_context.audit_mcp_call(tool, decision)` (migration `0010`) is an owner-run `SECURITY DEFINER` helper with `search_path = pg_catalog, pg_temp`, allowlisted for and executable by the data role only. It needs a verified **token** context for the current pid and xid, with any scopes, so read-only tokens are audited too. `tool` must be one of the 10 MCP tool names and `decision` `allowed` or `denied`; anything else raises `42501`. It inserts one `app.activity` row: team, actor and token from the context, `actor_type 'token'`, kind `mcp-tool`, no record, action `mcp.tool_called` or `mcp.tool_denied`, and metadata `{tool, oauthClientId}` taken from the context token's `auth.api_tokens.oauth_client_id`. Migration `0010` recreates the `app.activity` `context_insert` policy: the general branch now excludes `api-token` and `mcp-tool`, and an owner-only branch, like the token-audit one, admits `mcp-tool` rows with those two actions. No runtime role can insert `mcp-tool` rows directly. `/api/mcp` calls the helper in its own `withTeam` transaction before each tool runs; if it fails, the tool does not run.

### Export audit

`tenant_context.audit_export(resource, row_count, filter_keys)` (migration `0013_export_audit.sql`) sits next to `audit_mcp_call`. It is an owner-run `SECURITY DEFINER` helper with `search_path = pg_catalog, pg_temp`, allowlisted for and executable by the data role only. It needs a verified context, `session` or `token`, for the current pid and xid that has not expired, with any scopes, so viewers and read-only tokens, which hold no write scope and could not pass the general insert branch, are audited too. The context must hold `candidates:read` when `resource` is `candidates` and `recruitment:read` otherwise. `resource` must be one of the eight exportable lists (`candidates`, `job-roles`, `vacancies`, `applications`, `tasks`, `interviews`, `offers`, `onboarding`), `row_count` between 0 and 100,000, and `filter_keys` non-null, at most 40 entries and only the export filter keys (`EXPORT_FILTER_KEYS` in `src/lib/records.ts`; a test compares the two lists). Anything else raises `42501` and inserts nothing. It inserts one `app.activity` row: team, actor, auth type and token from the context, kind `export`, no record, action `records.exported`, summary `Exported {rows} {resource}` and metadata `{resource, rows, filters}` with the sorted, distinct keys. Filter values, search text and row IDs are never stored. Migration `0013` recreates the `app.activity` `context_insert` policy with the 0011 branches unchanged except that the general branch also excludes `export`, plus one owner-only branch for `export` / `records.exported` rows, like the `mcp-tool` one. No runtime role can insert `export` rows directly. `POST /api/v1/{resource}/export` reads the rows and their total in one statement and calls the helper in the same `withTeam` transaction; if the helper fails, the request fails and no file is sent. The data role may now execute ten helpers (`dataRoleHelpers` in `src/db/connection-boundary.ts`).

### OAuth reuse audit

`tenant_context.audit_grant_reuse(grant_id, reason)` (migration `0011_oauth_reuse_audit.sql`) sits next to `audit_token` and `audit_mcp_call`. It is an owner-run `SECURITY DEFINER` helper with `search_path = pg_catalog, pg_temp`, allowlisted for and executable by the identity role only. The token endpoint has no session or token context, so the helper needs none; instead every value except the reason comes from the grant row, and it raises `42501` and inserts nothing unless all of these hold:

- `reason` is `authorization_code_reused` or `refresh_token_reused`;
- the `auth.api_tokens` row exists and has `oauth_client_id` set;
- its `revoked_at` equals `transaction_timestamp()`, so it was revoked in this transaction;
- for `authorization_code_reused` a code of the grant has `used_at` set, for `refresh_token_reused` a refresh token of the grant has;
- no `api-token` / `token.revoked` row with that `tokenId` exists yet.

It inserts one `app.activity` row: the grant's team, its user as actor, `actor_type 'token'`, the grant id as `token_id`, kind `api-token`, action `token.revoked`, the fixed summary "Revoked an OAuth connection after a reused credential" and metadata `{tokenId, prefix, reason}`. `revokeGrant()` uses `UPDATE … RETURNING`, so the helper runs only when that call revoked the grant; an already revoked grant writes nothing. Migration `0011` recreates the `app.activity` `context_insert` policy with the 0010 branches unchanged plus one owner-only branch for `api-token` / `token.revoked` / `actor_type 'token'` rows that needs no context. It also adds `revocation_owner_read`, an owner-only `SELECT` policy for `api-token` / `token.revoked` rows, because FORCE RLS would otherwise hide existing revocation rows from the helper's at-most-once check when no context is installed. Both match only when `current_user` owns `tenant_context`, so they never match a runtime role, which still cannot insert or read such rows without a context.

### Open items

- Independent database and security review of this design, the definer functions and the allowlist (DEC-02, DEC-03).
- The WP-02 grant template is done locally ([postgres-split-runtime-roles.sql](../infrastructure/postgres-split-runtime-roles.sql), with the read-only `scripts/db-role-evidence.ts`). In the owner's run it is applied to the Neon Preview database and the evidence script passes with zero drift. Production provisioning remains. The database-owner clause WP-02e added to `runtimeRoleSafetyQuery` has not yet been run against Preview; the template roles do not own the database, so the evidence is expected to hold. PGlite is single-connection, so pooled reuse and revocation were proved sequentially there.
- The opt-in live harness `scripts/live-role-tests.ts` (`npm run test:live-roles`, WP-02c) exists and passed with independent connections on a throwaway local PostgreSQL 18 cluster: tenant isolation, forged and replayed contexts, pooled reuse, revocation and demotion, last-owner and bootstrap races, store-budget and read-lease races, and no audit row from a denied mutation. On Neon Preview the owner's run passed 27/27 over direct endpoints and 21/27 with all three connections through the pooler; fixtures were removed both times. WP-02d traced the six pooled failures to the harness's out-of-transaction pid reads and verified pooler behaviour locally behind PgBouncer in transaction mode: 27/27 in both bootstrap variants, with no application defect (see [Replay, savepoint and pool rules](#replay-savepoint-and-pool-rules)). The owner's Preview rerun then passed 27/27 through the transaction-mode pooler and 27/27 direct, with all fixtures removed. Lock contention under real traffic remains open.
- The "capability issued before commit" problem for quota issuance (WP-04/WP-05): a rolled-back transaction cannot withdraw a capability already returned to a client.
- Review of the WP-04 choice to charge the CV ledger under the verified context through `tenant_context.lock_storage_allocation` and owner-run triggers, rather than through a separately signed quota command (item 5).
- WP-02e replaced the blanket hosted guard in `createDbPair()` with the precise startup refusals listed at the top of this document. Independent review (DEC-02/DEC-03) and Production verification remain open, and the guard removal awaits the owner's release-gate sign-off. WP-03b opened hosted sign-in behind explicit readiness checks that reuse the same pre-pool refusals; Blob CV storage stays disabled in code.

## Preview-first migration and verification

1. Before provisioning, inspect the exact target Vercel project, environment, Neon project/branch/database identifiers, current data and role memberships, migration ledger, ownership, default privileges, grants and backup/recovery requirements without revealing credentials. Confirm Preview and Production are distinct and do not automatically copy real data. Stop if either is unexpected or nonempty; do not alter unrelated roles or databases.
2. Review the implementation and new migrations before execution. Use the dedicated Preview database's direct non-pooler migration-owner connection; the existing migration script uses a session advisory lock. Apply only the reviewed, explicit grants of [postgres-split-runtime-roles.sql](../infrastructure/postgres-split-runtime-roles.sql) to the intended database. The role names `recruitmentos_data` and `recruitmentos_identity` are the same in each environment's separate database; each environment has distinct credentials, and the connection marker tells the databases apart. Configure separate secret connections securely in the matching Vercel environment only after approval and verification. Keep the owner connection out of deployed runtime settings. Review migration `0004_protect_initial_admin_claim.sql`: it removes marker-write grants from every nonowner grantee, including any maintenance roles in the targeted database.
3. Use two or more independent connections and fictional users, teams and CVs. Verify initial-admin setup, verification and interrupted recovery; email/password sign-in, reset and sign-out; OAuth behavior when configured; team creation, invitations, acceptance, owner protections and membership removal; token create/list/authenticate/rate-limit/revoke, concurrent token caps and atomic audit. Test that rejected writes and failed audit roll back together, while rate-limit counters retain their intended commits.
4. Under the actual restricted data role, try direct and inherited grants, `SET ROLE`, writable identity views/functions, `PUBLIC` and default privileges, session/token/member/account mutation and the forged-token signer-oracle scenario. Assert denial. Attempt arbitrary team/user GUCs, guessed tenant and candidate IDs, invalid/expired/replayed/changed-field assertions, read-only or revoked tokens, concurrent revocation, quota oversubscription, cross-tenant reads/writes, private activity and forged audit. Verify all are denied at the intended boundary with independent connections. Check identity role cannot read candidate/CV content.
5. Run synthetic private Blob tests only after the trusted boundary and durable accounting are implemented: replay, duplicate/concurrent PUT, exact path/type/size and no-overwrite, late in-flight completion, crash/retry and retained charges, cleanup/reconciliation, changed or missing objects, per-slice reauthorization and 10 MiB assembly. Confirm provider guarantees with current documentation or provider support; tests alone cannot prove undocumented behavior. Keep Blob disabled until all controls, limits and rollback procedures pass review.
6. Review preview evidence and effective privileges, then apply the equivalent reviewed process separately to Production only when its environment is configured and the existing deployment authorization applies. Never reuse Preview credentials, data, signing keys, storage or operator connection. Live verification, actual provider behavior and a protected deployment access check remain open.

Related: [Blob quota design](blob-quota-design.md), [Neon database runbook](neon-database-runbook.md), and [Blob security design](blob-security-design.md).
