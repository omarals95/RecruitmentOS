-- LEGACY TEST FIXTURE ONLY: this shared role can read and modify auth data and
-- forge tenant context. It is unsafe and MUST NOT be used in any deployment.
-- Retained solely for synthetic regression tests of the legacy vulnerability.
CREATE ROLE recruitment_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE neondb TO recruitment_runtime;
GRANT USAGE ON SCHEMA auth,app TO recruitment_runtime;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON auth.initial_admin_claim FROM recruitment_runtime;
GRANT SELECT ON auth.initial_admin_claim TO recruitment_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.organization,auth.session,auth.account,auth.verification,auth.member,auth.invitation,auth.rate_limit,auth.api_tokens,auth.api_rate_limits TO recruitment_runtime;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA app TO recruitment_runtime;
GRANT DELETE ON app.candidate_states,app.notification_reads,app.idempotency TO recruitment_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA auth,app TO recruitment_runtime;
-- Runtime must not own app tables, inherit an owner role, or bypass RLS.
-- Reapply grants for newly introduced tables after future migrations.
