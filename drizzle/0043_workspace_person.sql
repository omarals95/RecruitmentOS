-- Workspace person (ADM-08, job 076). Apply after 0042_workspace_people.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.workspace_person; the identity role gets nothing. The Admin portal's user detail
-- page shows company owners and company admins with people one person of the workspace: profile,
-- teams and roles in this workspace, company authority, the two-step flag, a count of signed-in
-- devices and up to 50 configuration and access-change events, by ids, codes and names only (D1,
-- TST-005: never team data). No table, policy, trigger or other function changes. The storage
-- schema marker goes to 21, so startup refuses a database without this migration.

-- Company owner sessions and company admin sessions holding people only (42501 otherwise); a null,
-- empty or over-long id is 22023. Zero rows when the person has no membership in a team of the
-- context's workspace, so an unknown id and a person of another workspace look the same. Otherwise
-- one row: teams of this workspace only, the person's app.workspace_admins row of this workspace (or
-- nulls), the sessions that have not expired as signed-in devices, and events newest first, at most
-- 50: configuration changes the person made (another team's task boards left out, as in
-- config_history), configured role and home unit changes about them in this workspace, and company
-- authority changes and two-step resets naming them in a team of this workspace. No team id, record,
-- candidate, upload, storage, token, session, IP, user agent, summary or metadata body.
CREATE FUNCTION tenant_context.workspace_person(target_user_id text)
RETURNS TABLE (user_id text, name text, email text, last_sign_in timestamptz, two_step boolean,
  signed_in_devices integer, teams jsonb, company_level text, company_areas text[], plan_access boolean,
  authority_suspended boolean, authority_since timestamptz, events jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL OR ctx.company_level IS NULL
     OR NOT (ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas))) THEN
    RAISE EXCEPTION 'Workspace person rejected' USING ERRCODE = '42501';
  END IF;
  IF workspace_person.target_user_id IS NULL OR workspace_person.target_user_id = ''
     OR length(workspace_person.target_user_id) > 128 THEN
    RAISE EXCEPTION 'Workspace person rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH team AS (
    SELECT o.id AS team_id, o.name AS team_name, o.slug AS team_ident
      FROM app.workspace_teams wt JOIN auth.organization o ON o.id = wt.team_id
      WHERE wt.workspace_id = ctx.workspace_id
  ), event AS (
    SELECT act.id AS event_id, act.created_at AS event_at, act.action AS event_action, act.actor_id AS event_actor,
      au.name AS event_actor_name,
      CASE WHEN act.kind = 'config' THEN act.metadata->>'type' END AS event_type,
      CASE WHEN act.kind = 'config' THEN act.metadata->>'key' END AS event_key,
      CASE WHEN act.kind = 'role-assignment' THEN rv.body->>'name' END AS event_role
    FROM app.activity act
    JOIN team tm ON tm.team_id = act.team_id
    LEFT JOIN auth."user" au ON au.id = act.actor_id
    LEFT JOIN app.config_versions rv ON act.kind = 'role-assignment'
      AND rv.id::text = act.metadata->>'roleVersionId' AND rv.workspace_id = ctx.workspace_id
    WHERE (act.kind = 'config' AND act.actor_id = workspace_person.target_user_id
        AND act.metadata->>'workspaceId' = ctx.workspace_id::text
        AND (act.metadata->>'type' IS DISTINCT FROM 'task-board' OR act.team_id = ctx.team_id))
      OR (act.kind = 'role-assignment' AND act.action IN ('role.assigned', 'role.cleared')
        AND act.metadata->>'affectedUserId' = workspace_person.target_user_id
        AND act.metadata->>'workspaceId' = ctx.workspace_id::text)
      OR (act.kind = 'scope' AND act.action = 'scope.home_units_changed'
        AND act.metadata->'affectedUserIds' @> jsonb_build_array(workspace_person.target_user_id)
        AND act.metadata->>'workspaceId' = ctx.workspace_id::text)
      OR (act.kind = 'workspace-authority' AND act.action = 'workspace_authority.changed'
        AND act.metadata->>'targetUserId' = workspace_person.target_user_id)
      OR (act.kind = 'account-security' AND act.action = 'two_step.reset'
        AND act.metadata->>'targetUserId' = workspace_person.target_user_id)
    ORDER BY act.created_at DESC, act.id DESC
    LIMIT 50
  )
  SELECT u.id, u.name, u.email,
    (SELECT max(s.created_at) FROM auth.session s WHERE s.user_id = u.id),
    coalesce(u.two_factor_enabled, false),
    (SELECT count(*)::integer FROM auth.session s WHERE s.user_id = u.id AND s.expires_at > clock_timestamp()),
    (SELECT jsonb_agg(jsonb_build_object('team', tm.team_name, 'slug', tm.team_ident, 'teamRole', m.role,
        'configuredRole', (SELECT coalesce(cv.body->>'name', dv.body->>'name') FROM app.member_roles r
           JOIN app.config_objects co ON co.id = r.role_object_id AND co.workspace_id = ctx.workspace_id
           LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
           LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
           WHERE r.team_id = m.organization_id AND r.user_id = m.user_id))
        ORDER BY tm.team_name, tm.team_ident)
      FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id),
    a.level, a.areas, a.plan_access,
    CASE WHEN a.workspace_id IS NULL THEN NULL ELSE a.suspended_at IS NOT NULL END,
    a.granted_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('occurredAt', ev.event_at, 'action', ev.event_action,
        'actorId', ev.event_actor, 'actorName', ev.event_actor_name, 'objectType', ev.event_type,
        'objectKey', ev.event_key, 'roleName', ev.event_role) ORDER BY ev.event_at DESC, ev.event_id DESC)
      FROM event ev), '[]'::jsonb)
  FROM auth."user" u
  LEFT JOIN app.workspace_admins a ON a.workspace_id = ctx.workspace_id AND a.user_id = u.id
  WHERE u.id = workspace_person.target_user_id
    AND EXISTS (SELECT 1 FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id);
END $$;
REVOKE ALL ON FUNCTION tenant_context.workspace_person(text) FROM PUBLIC;

-- The code now calls the helper; startup refuses a database without it.
UPDATE db_boundary.storage_schema SET version = 21;
