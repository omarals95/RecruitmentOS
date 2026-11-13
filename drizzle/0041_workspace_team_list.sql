-- Workspace team list (ADM-02, job 069). Apply after 0040_record_pins.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.workspace_team_list; the identity role gets nothing. The Admin portal's Teams list
-- shows company owners and admins every team of the workspace by name, slug and created date only
-- (TST-005: company authority never opens team data). No table, policy, trigger or other function
-- changes. The storage schema marker goes to 19, so startup refuses a database without this
-- migration.

-- Company owner and admin sessions only (42501 otherwise): every team mapped to the context's
-- workspace, ordered by name then slug. Id, name, slug and created date only: no member, count,
-- record, storage or activity of any team.
CREATE FUNCTION tenant_context.workspace_team_list()
RETURNS TABLE (id text, name text, slug text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS NULL OR ctx.company_level NOT IN ('owner', 'admin') OR ctx.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Workspace team list rejected' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT o.id, o.name, o.slug, o.created_at
    FROM app.workspace_teams t
    JOIN auth.organization o ON o.id = t.team_id
    WHERE t.workspace_id = ctx.workspace_id
    ORDER BY o.name, o.slug;
END $$;
REVOKE ALL ON FUNCTION tenant_context.workspace_team_list() FROM PUBLIC;

-- The code now calls the helper; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 19;
