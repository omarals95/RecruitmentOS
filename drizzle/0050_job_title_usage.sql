-- Job title usage (ADM-27, job 088). Apply after 0049_record_files.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.job_title_usage; the identity role gets nothing. Before a title's grade changes,
-- the Job titles view shows company owners and company admins with organisation how many current
-- positions, open vacancies and open offers of the context's workspace use the title: three counts
-- across every team, never an id, name, team, date or per-team breakdown (architecture 9.3 and
-- 14.5). No table, policy, trigger or other function changes, and no row is rewritten. The storage
-- schema marker goes to 28, so startup refuses a database without this migration.

-- Session contexts of a company owner or a company admin with organisation only (42501 otherwise,
-- a null key 22023). One row of three counts for the context's workspace: current positions with
-- the title; unarchived Open vacancies with the title; unarchived Draft or Sent offers whose
-- application's vacancy has the title, in any team mapped to the workspace. It reads the rows as the
-- owner, through the owner policies, and writes nothing (no activity row per call).
CREATE FUNCTION tenant_context.job_title_usage(title_key text)
RETURNS TABLE (positions integer, open_vacancies integer, open_offers integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL
    OR NOT tenant_context.allows_workspace(ctx.workspace_id, 'write', 'organisation') THEN
    RAISE EXCEPTION 'Job title usage rejected' USING ERRCODE = '42501';
  END IF;
  IF title_key IS NULL THEN
    RAISE EXCEPTION 'Job title usage needs a title key' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM app.positions p
      WHERE p.workspace_id = ctx.workspace_id AND p.job_title_key = title_key
        AND p.valid_to IS NULL AND p.archived_at IS NULL),
    (SELECT count(*)::integer FROM app.records v
      JOIN app.workspace_teams t ON t.team_id = v.team_id AND t.workspace_id = ctx.workspace_id
      WHERE v.kind = 'vacancy' AND v.archived_at IS NULL
        AND v.data @> pg_catalog.jsonb_build_object('jobTitleKey', title_key, 'status', 'Open')),
    (SELECT count(*)::integer FROM app.records o
      JOIN app.workspace_teams t ON t.team_id = o.team_id AND t.workspace_id = ctx.workspace_id
      JOIN app.records a ON a.team_id = o.team_id AND a.id = o.application_id AND a.kind = 'application'
      JOIN app.records v ON v.team_id = a.team_id AND v.id = a.vacancy_id AND v.kind = 'vacancy'
      WHERE o.kind = 'offer' AND o.archived_at IS NULL AND o.data->>'status' IN ('Draft', 'Sent')
        AND v.data @> pg_catalog.jsonb_build_object('jobTitleKey', title_key));
END $$;
REVOKE ALL ON FUNCTION tenant_context.job_title_usage(text) FROM PUBLIC;

-- The code now calls the helper; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 28;
