-- RecruitmentOS split runtime roles: recruitmentos_data (recruitment data pool) and
-- recruitmentos_identity (identity pool), with exact object-by-object grants.
--
-- - Run it as the migration owner (the role that ran db:migrate and owns schema tenant_context)
--   over a direct, non-pooler connection, for example:
--   psql -v ON_ERROR_STOP=1 -f infrastructure/postgres-split-runtime-roles.sql
-- - Rerun it after every migration. It revokes everything either runtime role holds on the
--   protected schemas and grants the matrix below again, so a rerun removes any extra privilege.
--   Update it whenever a migration adds a table, sequence or function: new owner objects are
--   unusable by both runtime roles and PUBLIC until they are listed here.
-- - It closes this database to PUBLIC (no CONNECT or TEMPORARY) and the public schema to PUBLIC
--   and both runtime roles. Only the two runtime roles get CONNECT; the owner keeps its access.
--   scripts/db-role-evidence.ts compares each role's effective privileges with the grants below.
-- - It never sets passwords. The operator sets each password separately, for example with
--   \password recruitmentos_data in psql, never in this file, shell history or logs.
-- - It is verified on PGlite and a throwaway local PostgreSQL. In the owner's run it has been
--   applied to the Neon Preview database, with scripts/db-role-evidence.ts at zero drift. It is
--   not verified on Production. Applying it removes no hosted startup check.
--
-- Plain SQL only (no psql meta-commands), one transaction; any refusal rolls back everything.
BEGIN;

-- Refuse before any change; an existing role is verified, never altered.
DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_namespace n
      WHERE n.nspname IN ('auth', 'app', 'tenant_context', 'db_boundary', 'storage_ledger')) <> 5 THEN
    RAISE EXCEPTION 'Apply every migration before the runtime role template.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname = 'tenant_context' AND pg_catalog.pg_get_userbyid(n.nspowner) = current_user) THEN
    RAISE EXCEPTION 'Run the runtime role template as the owner of schema tenant_context.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.rolname IN ('recruitmentos_data', 'recruitmentos_identity')
        AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls
          OR r.rolreplication OR NOT r.rolcanlogin)) THEN
    RAISE EXCEPTION 'An existing runtime role has unsafe attributes; it is not changed here.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE r.rolname IN ('recruitmentos_data', 'recruitmentos_identity')) THEN
    RAISE EXCEPTION 'An existing runtime role is a member of another role; it is not changed here.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'recruitmentos_data') THEN
    CREATE ROLE recruitmentos_data LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'recruitmentos_identity') THEN
    CREATE ROLE recruitmentos_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
END $preflight$;

-- Converge: drop every privilege the runtime roles and PUBLIC hold in the protected schemas, the
-- public schema and this database.
REVOKE ALL ON SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  FROM PUBLIC, recruitmentos_data, recruitmentos_identity CASCADE;
REVOKE ALL ON ALL TABLES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  FROM PUBLIC, recruitmentos_data, recruitmentos_identity CASCADE;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  FROM PUBLIC, recruitmentos_data, recruitmentos_identity CASCADE;
REVOKE ALL ON ALL ROUTINES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  FROM PUBLIC, recruitmentos_data, recruitmentos_identity CASCADE;
REVOKE ALL ON SCHEMA public FROM PUBLIC, recruitmentos_data, recruitmentos_identity CASCADE;
DO $database$
BEGIN
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC, recruitmentos_data, recruitmentos_identity CASCADE',
    pg_catalog.current_database());
END $database$;

-- Fail closed for future owner objects: no default grant to either runtime role or PUBLIC.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SCHEMAS FROM recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  REVOKE ALL ON TABLES FROM PUBLIC, recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  REVOKE ALL ON SEQUENCES FROM PUBLIC, recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth, app, tenant_context, db_boundary, storage_ledger
  REVOKE ALL ON TYPES FROM PUBLIC, recruitmentos_data, recruitmentos_identity;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Both roles: connect to this database only.
DO $connect$
BEGIN
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO recruitmentos_data, recruitmentos_identity',
    pg_catalog.current_database());
END $connect$;

-- recruitmentos_data: recruitment tables under FORCE RLS, the markers and the allowlisted helpers.
-- The erasure tombstones in app.candidate_erasures and app.employee_erasures are owner-only: neither
-- runtime role gets a grant.
GRANT USAGE ON SCHEMA app TO recruitmentos_data;
GRANT USAGE ON SCHEMA tenant_context TO recruitmentos_data;
GRANT USAGE ON SCHEMA db_boundary TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.records TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.candidate_states TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.activity TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.uploads TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.storage_usage TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.idempotency TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.notification_reads TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.bulk_intake_batches TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.bulk_intake_items TO recruitmentos_data;
GRANT SELECT, INSERT, DELETE ON TABLE app.speed_samples TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.speed_sample_budgets TO recruitmentos_data;
GRANT SELECT ON TABLE app.workspaces TO recruitmentos_data;
GRANT SELECT ON TABLE app.workspace_teams TO recruitmentos_data;
GRANT SELECT ON TABLE app.workspace_admins TO recruitmentos_data;
GRANT SELECT ON TABLE app.workspace_users TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.config_objects TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.config_versions TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.config_layouts TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.org_levels TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.org_units TO recruitmentos_data;
GRANT SELECT ON TABLE app.org_unit_closure TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.positions TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.employees TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE ON TABLE app.employee_positions TO recruitmentos_data;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.member_roles TO recruitmentos_data;
-- Read only: assignments are written only through tenant_context.add_assignment and remove_assignment.
GRANT SELECT ON TABLE app.record_assignments TO recruitmentos_data;
GRANT SELECT ON TABLE db_boundary.connection_marker TO recruitmentos_data;
GRANT SELECT ON TABLE db_boundary.storage_schema TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.allows(text, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.allows_activity(text, text, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.allows_event(text, text, text, uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.activity_actor_name(uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.lock_storage_allocation(text, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.acquire_blob_read(text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.release_blob_read(uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.audit_mcp_call(text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.audit_export(text, integer, text[]) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.purge_bulk_intake(uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.set_storage_limits(bigint, integer, integer) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.release_blob_charge(text, uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.claim_blob_reconciliation(text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.erase_candidate(uuid, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.erase_employee(uuid, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.set_mcp_cv_text_access(boolean) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.audit_mcp_cv_read(text, uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.set_workspace_authority(text, text, text[], boolean) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.allows_workspace_admin(uuid, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.allows_workspace(uuid, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.publish_config_version(uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.retire_config_version(uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.audit_config(uuid, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.config_history(uuid, timestamp with time zone, integer) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.allows_directory(uuid, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.home_unit_changes(timestamp with time zone, integer) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.role_assignment_changes(timestamp with time zone, integer) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.workspace_team_list() TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.workspace_people(text, text, text, text, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.workspace_person(text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.set_team_archived(text, boolean) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.member_archived_teams() TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.set_user_active(text, boolean) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.add_assignment(uuid, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.remove_assignment(uuid, text, text) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.scope_is_all() TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.in_scope(text, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.record_in_scope(text, uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.candidate_in_scope(text, uuid) TO recruitmentos_data;
GRANT EXECUTE ON FUNCTION tenant_context.context_actor_key() TO recruitmentos_data;

-- recruitmentos_identity: Better Auth and API token tables, the OAuth tables (DELETE only for the
-- expired-row purge; no UPDATE on clients), the setup marker read-only, the connection marker and
-- the five identity helpers.
GRANT USAGE ON SCHEMA auth TO recruitmentos_identity;
GRANT USAGE ON SCHEMA tenant_context TO recruitmentos_identity;
GRANT USAGE ON SCHEMA db_boundary TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth."user" TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.organization TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.session TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.account TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.verification TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.two_factor TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.member TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.invitation TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.rate_limit TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.api_tokens TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.api_rate_limits TO recruitmentos_identity;
GRANT SELECT, INSERT, DELETE ON TABLE auth.oauth_clients TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.oauth_codes TO recruitmentos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.oauth_tokens TO recruitmentos_identity;
GRANT SELECT ON TABLE auth.initial_admin_claim TO recruitmentos_identity;
GRANT SELECT ON TABLE db_boundary.connection_marker TO recruitmentos_identity;
GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO recruitmentos_identity;
GRANT EXECUTE ON FUNCTION tenant_context.audit_token(text, text) TO recruitmentos_identity;
GRANT EXECUTE ON FUNCTION tenant_context.audit_grant_reuse(text, text) TO recruitmentos_identity;
GRANT EXECUTE ON FUNCTION tenant_context.reset_two_step(text) TO recruitmentos_identity;
GRANT EXECUTE ON FUNCTION tenant_context.user_account_action(text, text) TO recruitmentos_identity;

-- A revoke by a role that does not own the database or the public schema only warns; refuse instead.
DO $closed$
BEGIN
  IF pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'CONNECT, TEMPORARY')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname = 'public' AND pg_catalog.has_schema_privilege('public', n.oid, 'USAGE, CREATE')) THEN
    RAISE EXCEPTION 'PUBLIC still has database or public schema access; run the runtime role template as the database owner.';
  END IF;
END $closed$;

COMMIT;
