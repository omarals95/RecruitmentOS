-- Workspace people (ADM-07, job 073). Apply after 0041_workspace_team_list.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.workspace_people; the identity role gets nothing. The new grantable company area
-- people joins the area check of app.workspace_admins and tenant_context.set_workspace_authority.
-- The Admin portal's Users list shows company owners and company admins with people everyone in
-- every team of the workspace, and every pending invitation, by name, email, teams and roles only
-- (D1, TST-005: never team data). No policy, trigger or other function changes. The storage schema
-- marker goes to 20, so startup refuses a database without this migration.

-- As in 0028, plus people. Existing rows hold only the earlier areas, so they stay valid.
ALTER TABLE app.workspace_admins DROP CONSTRAINT workspace_admins_areas_check,
  ADD CONSTRAINT workspace_admins_areas_check CHECK (array_position(areas, NULL) IS NULL AND CASE level
    WHEN 'owner' THEN areas = '{}'
    ELSE areas <@ ARRAY['fields','workflows','boards','organisation','templates','people']
      AND cardinality(array_positions(areas, 'fields')) <= 1
      AND cardinality(array_positions(areas, 'workflows')) <= 1
      AND cardinality(array_positions(areas, 'boards')) <= 1
      AND cardinality(array_positions(areas, 'organisation')) <= 1
      AND cardinality(array_positions(areas, 'templates')) <= 1
      AND cardinality(array_positions(areas, 'people')) <= 1 END);

-- As in 0029, except that an admin may also hold people. CREATE OR REPLACE keeps its grants.
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

-- Company owner sessions and company admin sessions holding people only (42501 otherwise). People:
-- every user with a membership in a team of the context's workspace, with that workspace's teams
-- only. Invited: each lower-cased email with a pending, unexpired invitation to a team of the
-- workspace that belongs to no member of a workspace team. Filters combine with AND; an unknown slug
-- or key matches nothing, and invited rows never match a role. Ordered by (sort_key, row_key), after
-- the cursor when one is given, at most 26 rows: a page of 25 and one that only says more exist.
-- No team id, member count, record, candidate, upload, storage, activity, token, session or two-step
-- secret, and nothing of a team or person outside the workspace.
CREATE FUNCTION tenant_context.workspace_people(team_slug text, person_status text, level_filter text, role_key text,
  after_sort text, after_key text)
RETURNS TABLE (user_id text, name text, email text, teams jsonb, company_level text, status text,
  last_sign_in timestamptz, two_step boolean, sort_key text, row_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL OR ctx.company_level IS NULL
     OR NOT (ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas))) THEN
    RAISE EXCEPTION 'Workspace people rejected' USING ERRCODE = '42501';
  END IF;
  IF (workspace_people.person_status IS NOT NULL AND workspace_people.person_status NOT IN ('active', 'invited'))
     OR (workspace_people.level_filter IS NOT NULL AND workspace_people.level_filter NOT IN ('owner', 'admin', 'none'))
     OR ((workspace_people.after_sort IS NULL) <> (workspace_people.after_key IS NULL)) THEN
    RAISE EXCEPTION 'Workspace people rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH team AS (
    SELECT o.id AS team_id, o.name AS team_name, o.slug AS team_ident
      FROM app.workspace_teams wt JOIN auth.organization o ON o.id = wt.team_id
      WHERE wt.workspace_id = ctx.workspace_id
  ), chosen AS (
    SELECT tm.team_id FROM team tm WHERE tm.team_ident = workspace_people.team_slug
  ), pending AS (
    SELECT DISTINCT lower(i.email) AS invited_email, i.organization_id AS team_id, i.role AS team_role
      FROM auth.invitation i JOIN team tm ON tm.team_id = i.organization_id
      WHERE i.status = 'pending' AND i.expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM auth.member m JOIN team mt ON mt.team_id = m.organization_id
          JOIN auth."user" mu ON mu.id = m.user_id WHERE lower(mu.email) = lower(i.email))
  ), listed AS (
    SELECT u.id AS person_id, u.name AS person_name, u.email AS person_email,
      (SELECT jsonb_agg(jsonb_build_object('team', tm.team_name, 'teamRole', m.role, 'configuredRole',
          (SELECT coalesce(cv.body->>'name', dv.body->>'name') FROM app.member_roles r
             JOIN app.config_objects co ON co.id = r.role_object_id AND co.workspace_id = ctx.workspace_id
             LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
             LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
             WHERE r.team_id = m.organization_id AND r.user_id = m.user_id))
          ORDER BY tm.team_name, tm.team_ident)
        FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id) AS person_teams,
      (SELECT a.level FROM app.workspace_admins a
        WHERE a.workspace_id = ctx.workspace_id AND a.user_id = u.id AND a.suspended_at IS NULL) AS person_level,
      'active'::text AS person_state,
      (SELECT max(s.created_at) FROM auth.session s WHERE s.user_id = u.id) AS person_sign_in,
      coalesce(u.two_factor_enabled, false) AS person_two_step,
      lower(u.name) AS person_sort, u.id AS person_row
    FROM auth."user" u
    WHERE EXISTS (SELECT 1 FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id)
      AND (workspace_people.team_slug IS NULL OR EXISTS (SELECT 1 FROM auth.member m
        JOIN chosen ch ON ch.team_id = m.organization_id WHERE m.user_id = u.id))
      AND (workspace_people.role_key IS NULL OR EXISTS (SELECT 1 FROM app.member_roles r
        JOIN team tm ON tm.team_id = r.team_id
        JOIN app.config_objects co ON co.id = r.role_object_id
        WHERE r.user_id = u.id AND co.workspace_id = ctx.workspace_id AND co.type = 'role'
          AND co.key = workspace_people.role_key
          AND (workspace_people.team_slug IS NULL OR r.team_id IN (SELECT ch.team_id FROM chosen ch))))
    UNION ALL
    SELECT NULL, NULL, pd.invited_email,
      jsonb_agg(jsonb_build_object('team', tm.team_name, 'teamRole', pd.team_role, 'configuredRole', NULL)
        ORDER BY tm.team_name, tm.team_ident, pd.team_role),
      NULL, 'invited', NULL, false, pd.invited_email, 'invitation:' || pd.invited_email
    FROM pending pd JOIN team tm ON tm.team_id = pd.team_id
    WHERE workspace_people.role_key IS NULL
    GROUP BY pd.invited_email
    HAVING workspace_people.team_slug IS NULL
      OR bool_or(pd.team_id IN (SELECT ch.team_id FROM chosen ch))
  )
  SELECT l.person_id, l.person_name, l.person_email, l.person_teams, l.person_level, l.person_state,
      l.person_sign_in, l.person_two_step, l.person_sort, l.person_row
    FROM listed l
    WHERE (workspace_people.person_status IS NULL OR l.person_state = workspace_people.person_status)
      AND (workspace_people.level_filter IS NULL
        OR (workspace_people.level_filter = 'none' AND l.person_level IS NULL)
        OR l.person_level = workspace_people.level_filter)
      AND (workspace_people.after_sort IS NULL
        OR (l.person_sort, l.person_row) > (workspace_people.after_sort, workspace_people.after_key))
    ORDER BY l.person_sort, l.person_row
    LIMIT 26;
END $$;
REVOKE ALL ON FUNCTION tenant_context.workspace_people(text, text, text, text, text, text) FROM PUBLIC;

-- The code now offers people and calls the helper; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 20;
