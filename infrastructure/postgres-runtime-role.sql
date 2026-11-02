-- Run as the Neon database owner AFTER migrations, outside the deployed app.
-- Pick a unique runtime role and set its password securely in the Neon console.
-- Do not save a real password in this file or commit it.
CREATE ROLE recruitment_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE neondb TO recruitment_runtime;
GRANT USAGE ON SCHEMA auth,app TO recruitment_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA auth TO recruitment_runtime;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA app TO recruitment_runtime;
GRANT DELETE ON app.candidate_states,app.notification_reads,app.idempotency TO recruitment_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA auth,app TO recruitment_runtime;
-- Runtime must not own app tables, inherit an owner role, or bypass RLS.
-- Reapply grants for newly introduced tables after future migrations.
