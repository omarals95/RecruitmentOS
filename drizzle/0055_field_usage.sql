-- Field usage (ADM-29, job 100). Apply after 0054_domain_audit.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.field_usage; the identity role gets nothing. The field detail page shows company
-- owners and company admins with fields how many records of the context's workspace hold a value of
-- one custom field of the published kind schema: one count across every team, never an id, value,
-- team, date or per-team breakdown (architecture 14.6, D1). No table, policy, trigger or other
-- function changes, and no row is rewritten. The storage schema marker goes to 33, so startup
-- refuses a database without this migration.

-- Session contexts of a company owner or a company admin with fields only (42501 otherwise; a null
-- argument or a kind that has no kind schema 22023). 0 unless field_id is the key of a custom field
-- of the workspace's current published kind schema of that kind, so a team's own task field is never
-- counted. Otherwise the records of that kind, archived ones included, in every team mapped to the
-- workspace, archived teams included, whose customValues hold the key with a value other than null,
-- "" and []. It reads the rows as the owner, through the owner policies, and writes nothing (no
-- activity row per call).
CREATE FUNCTION tenant_context.field_usage(kind text, field_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  schema_body jsonb;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL
    OR NOT tenant_context.allows_workspace(ctx.workspace_id, 'write', 'fields') THEN
    RAISE EXCEPTION 'Field usage rejected' USING ERRCODE = '42501';
  END IF;
  IF field_usage.kind IS NULL OR field_id IS NULL OR field_usage.kind NOT IN
    ('candidate','job-role','vacancy','application','task','interview','offer','onboarding','checklist') THEN
    RAISE EXCEPTION 'Field usage needs a configurable kind and a field id' USING ERRCODE = '22023';
  END IF;
  SELECT v.body INTO schema_body FROM app.config_objects o
    JOIN app.config_versions v ON v.id = o.current_version_id AND v.object_id = o.id
    WHERE o.workspace_id = ctx.workspace_id AND o.team_id IS NULL AND o.type = 'kind-schema'
      AND o.key = field_usage.kind AND o.archived_at IS NULL;
  IF schema_body IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(schema_body->'fields') f
      WHERE f->>'key' = field_id::text AND f->'system' = 'false'::jsonb) THEN
    RETURN 0;
  END IF;
  RETURN (SELECT count(*)::integer FROM app.records r
    JOIN app.workspace_teams t ON t.team_id = r.team_id AND t.workspace_id = ctx.workspace_id
    WHERE r.kind = field_usage.kind AND r.data->'customValues' ? field_id::text
      AND r.data->'customValues'->(field_id::text) NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION tenant_context.field_usage(text, uuid) FROM PUBLIC;

-- The code now calls the helper; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 33;
