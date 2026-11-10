-- Record pins (R2b-02, job 067). Apply after 0039_candidate_scope_index.sql; the role template is
-- unchanged and needs no rerun (infrastructure/postgres-split-runtime-roles.sql,
-- scripts/runtime-role-template.ts and src/db/connection-boundary.ts are unchanged): the data role's
-- table-level SELECT, INSERT and UPDATE on app.records already cover new columns. Records gain two
-- nullable pins: schema_version_id, the kind schema version a create or update validated against
-- (null means the built-in default compiled from code), and type_id, for record types (R2b-11). No
-- default, foreign key, index, trigger, policy, grant or function changes, and no row is rewritten:
-- every existing row keeps null pins until its next write. The storage schema marker goes to 18, so
-- startup refuses a database without this migration.
ALTER TABLE app.records ADD COLUMN IF NOT EXISTS schema_version_id uuid,
  ADD COLUMN IF NOT EXISTS type_id uuid;

-- The code now writes schema_version_id; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 18;
