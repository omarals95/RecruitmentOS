-- Two-step sign-in for company authority (ADM-16, job 077). Apply after 0042_workspace_people.sql;
-- no rerun of infrastructure/postgres-split-runtime-roles.sql is needed, because CREATE OR REPLACE
-- keeps the helper's signature, owner and grants. tenant_context.set_workspace_authority now also
-- refuses to grant a company level (owner or admin) to a user whose two-step flag is off, with
-- RQ017, after every existing refusal; removing a level is never refused for two-step. No row of
-- app.workspace_admins, constraint, policy, trigger, install or other function changes: existing
-- holders without two-step keep their rows and are asked to set it up at their next sign-in. The
-- storage schema marker goes to 21, so startup refuses a database without this migration.

-- As in 0042, plus the two-step check after the last-owner check. CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.set_workspace_authority(target_user_id text, new_level text, new_areas text[],
  new_plan_access boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  company uuid;
  before_row app.workspace_admins%ROWTYPE;
  sorted_areas text[];
  valid boolean;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF FOUND THEN
    SELECT t.workspace_id INTO company FROM app.workspace_teams t WHERE t.team_id = ctx.team_id;
  END IF;
  IF company IS NULL OR NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = company
       AND a.user_id = ctx.actor_id AND a.level = 'owner' AND a.suspended_at IS NULL) THEN
    RAISE EXCEPTION 'Workspace authority rejected' USING ERRCODE = '42501';
  END IF;
  -- One change at a time per workspace, with the suspension trigger; the caller may have lost
  -- authority while waiting.
  PERFORM 1 FROM app.workspaces w WHERE w.id = company FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = company
       AND a.user_id = ctx.actor_id AND a.level = 'owner' AND a.suspended_at IS NULL) THEN
    RAISE EXCEPTION 'Workspace authority rejected' USING ERRCODE = '42501';
  END IF;
  valid := target_user_id IS NOT NULL AND CASE
    WHEN new_level IS NULL THEN new_areas IS NULL AND new_plan_access IS NULL
    WHEN new_level IN ('owner', 'admin') THEN new_plan_access IS NOT NULL AND new_areas IS NOT NULL
      AND array_position(new_areas, NULL) IS NULL
      AND cardinality(new_areas) = (SELECT count(DISTINCT x) FROM unnest(new_areas) x)
      AND CASE new_level WHEN 'owner' THEN cardinality(new_areas) = 0
        ELSE new_areas <@ ARRAY['fields','workflows','boards','organisation','templates','people'] END
    ELSE false END;
  IF valid IS NOT TRUE THEN
    RAISE EXCEPTION 'Workspace authority rejected' USING ERRCODE = '22023';
  END IF;
  IF new_level IS NOT NULL THEN
    PERFORM 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
      WHERE m.user_id = target_user_id AND t.workspace_id = company FOR SHARE OF m;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The member is in no team of this company' USING ERRCODE = 'RQ006';
    END IF;
  END IF;
  SELECT * INTO before_row FROM app.workspace_admins a
    WHERE a.workspace_id = company AND a.user_id = target_user_id FOR UPDATE;
  IF before_row.level = 'owner' AND before_row.suspended_at IS NULL AND new_level IS DISTINCT FROM 'owner'
     AND NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = company
       AND a.user_id <> target_user_id AND a.level = 'owner' AND a.suspended_at IS NULL) THEN
    RAISE EXCEPTION 'The last company owner cannot be removed or demoted' USING ERRCODE = 'RQ005';
  END IF;
  -- Company owners and admins must use two-step sign-in (IAM-034): no level, unchanged or not, for a
  -- person without it. Removal stays allowed.
  IF new_level IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth."user" u
       WHERE u.id = target_user_id AND coalesce(u.two_factor_enabled, false)) THEN
    RAISE EXCEPTION 'Company authority needs two-step sign-in' USING ERRCODE = 'RQ017';
  END IF;
  sorted_areas := ARRAY(SELECT x FROM unnest(new_areas) x ORDER BY x);
  IF (before_row.user_id IS NULL AND new_level IS NULL)
     OR (before_row.user_id IS NOT NULL AND new_level IS NOT NULL AND before_row.suspended_at IS NULL
       AND before_row.level = new_level AND before_row.plan_access = new_plan_access
       AND ARRAY(SELECT x FROM unnest(before_row.areas) x ORDER BY x) = sorted_areas) THEN
    RETURN false;
  END IF;
  IF new_level IS NULL THEN
    DELETE FROM app.workspace_admins a WHERE a.workspace_id = company AND a.user_id = target_user_id;
  ELSE
    INSERT INTO app.workspace_admins(workspace_id, user_id, level, areas, plan_access, granted_by, granted_at,
      suspended_at)
    VALUES (company, target_user_id, new_level, sorted_areas, new_plan_access, ctx.actor_id, clock_timestamp(), NULL)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET level = EXCLUDED.level, areas = EXCLUDED.areas,
      plan_access = EXCLUDED.plan_access, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,
      suspended_at = NULL;
  END IF;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'workspace_authority.changed', 'workspace-authority',
    'Changed a member''s company authority',
    jsonb_build_object('targetUserId', target_user_id,
      'before', CASE WHEN before_row.user_id IS NOT NULL THEN jsonb_build_object('level', before_row.level,
        'areas', to_jsonb(before_row.areas), 'planAccess', before_row.plan_access,
        'suspended', before_row.suspended_at IS NOT NULL) END,
      'after', CASE WHEN new_level IS NOT NULL THEN jsonb_build_object('level', new_level,
        'areas', to_jsonb(sorted_areas), 'planAccess', new_plan_access, 'suspended', false) END));
  RETURN true;
END $$;

-- The code now maps RQ017 and gates sign-in for company authority; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 21;
