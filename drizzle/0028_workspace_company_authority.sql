-- Company workspace above teams (R2a-01, job 042). Apply after 0027_release_1_cleanup.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role SELECT on the three new
-- tables and the two new helpers below. The storage schema marker goes to 7, so startup refuses a
-- database without this migration. Team tables and tenant_context.install are unchanged.

-- One workspace per environment in Release 2 (D1, D15). Every team maps to it; company authority is
-- explicit in app.workspace_admins and never follows from auth.member.role.
CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.workspace_teams (
  team_id text PRIMARY KEY REFERENCES auth.organization(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id)
);
CREATE INDEX workspace_teams_workspace_idx ON app.workspace_teams(workspace_id);
-- An owner holds every area by level, so its row lists none; an admin never holds roles or ai. The
-- per-area position counts keep an admin's areas free of duplicates without a subquery.
CREATE TABLE app.workspace_admins (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('owner','admin')),
  areas text[] NOT NULL DEFAULT '{}',
  plan_access boolean NOT NULL DEFAULT false,
  granted_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_admins_areas_check CHECK (array_position(areas, NULL) IS NULL AND CASE level
    WHEN 'owner' THEN areas = '{}'
    ELSE areas <@ ARRAY['fields','workflows','boards','organisation','templates']
      AND cardinality(array_positions(areas, 'fields')) <= 1
      AND cardinality(array_positions(areas, 'workflows')) <= 1
      AND cardinality(array_positions(areas, 'boards')) <= 1
      AND cardinality(array_positions(areas, 'organisation')) <= 1
      AND cardinality(array_positions(areas, 'templates')) <= 1 END)
);
CREATE INDEX workspace_admins_user_idx ON app.workspace_admins(user_id);

DO $workspace_rls$ DECLARE tbl text; command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
 FOREACH tbl IN ARRAY ARRAY['workspaces','workspace_teams','workspace_admins'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', tbl);
  -- Owner-only access for the migration, both triggers, the helper and the owner SQL step: the owner
  -- is not a superuser on Neon, so FORCE RLS applies to it. A runtime role is never the owner.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'workspace_owner_' || lower(command), tbl, command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
 END LOOP;
END $workspace_rls$;

-- The fixed workspace, every existing team, and the initial administrator as the first company owner
-- when they are a member of a mapped team. Each insert is idempotent.
INSERT INTO app.workspaces(id, name) VALUES ('00000000-0000-4000-a000-000000000001', 'Company')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO app.workspace_teams(team_id, workspace_id)
  SELECT o.id, '00000000-0000-4000-a000-000000000001' FROM auth.organization o
  ON CONFLICT (team_id) DO NOTHING;
INSERT INTO app.workspace_admins(workspace_id, user_id, level, areas, plan_access, granted_by)
  SELECT '00000000-0000-4000-a000-000000000001', u.id, 'owner', '{}', false, NULL FROM auth."user" u
  WHERE u.initial_admin AND EXISTS (SELECT 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
    WHERE m.user_id = u.id AND t.workspace_id = '00000000-0000-4000-a000-000000000001')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- Policy predicate for app.workspace_admins: the current context's team is in the row's workspace,
-- and the row is the actor's own or the actor holds unsuspended company authority there. A policy
-- that read app.workspace_admins itself would recurse.
CREATE FUNCTION tenant_context.allows_workspace_admin(row_workspace uuid, row_user text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    JOIN app.workspace_teams t ON t.team_id = c.team_id
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND t.workspace_id = row_workspace
      AND (c.actor_id = row_user OR EXISTS (SELECT 1 FROM app.workspace_admins a
        WHERE a.workspace_id = row_workspace AND a.user_id = c.actor_id AND a.suspended_at IS NULL)))
$$;
REVOKE ALL ON FUNCTION tenant_context.allows_workspace_admin(uuid, text) FROM PUBLIC;

-- Runtime-facing reads only; no runtime context has an insert, update or delete policy. A context
-- sees its own team's mapping and its workspace, never another team's id.
CREATE POLICY context_read ON app.workspace_teams FOR SELECT USING (tenant_context.allows(team_id, NULL, 'read'));
CREATE POLICY context_read ON app.workspaces FOR SELECT USING (EXISTS (SELECT 1 FROM app.workspace_teams t
  WHERE t.workspace_id = workspaces.id AND tenant_context.allows(t.team_id, NULL, 'read')));
-- The owner reads through workspace_owner_select. Excluding it here, before the helper is called,
-- keeps the helper's own read of this table from calling the helper again.
CREATE POLICY context_read ON app.workspace_admins FOR SELECT USING (
  current_user <> (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
  AND tenant_context.allows_workspace_admin(workspace_id, user_id));

-- Maps every new team to the one workspace in the creating transaction; with no or a second workspace
-- every team creation fails (D15). The initial administrator's team creation also makes them company
-- owner while the workspace has no owner row, suspended or not; nothing else here grants authority.
CREATE FUNCTION app.map_new_team() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  company uuid;
BEGIN
  IF (SELECT count(*) FROM app.workspaces) <> 1 THEN
    RAISE EXCEPTION 'A team can only be created in the one company workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'app_single_workspace';
  END IF;
  SELECT w.id INTO company FROM app.workspaces w;
  INSERT INTO app.workspace_teams(team_id, workspace_id) VALUES (NEW.id, company);
  IF EXISTS (SELECT 1 FROM auth."user" u WHERE u.id = NEW.created_by AND u.initial_admin)
     AND NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = company AND a.level = 'owner') THEN
    INSERT INTO app.workspace_admins(workspace_id, user_id, level, areas, plan_access, granted_by)
      VALUES (company, NEW.created_by, 'owner', '{}', false, NULL) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.map_new_team() FROM PUBLIC;
CREATE TRIGGER workspace_map_new_team AFTER INSERT ON auth.organization
  FOR EACH ROW EXECUTE FUNCTION app.map_new_team();

-- Suspends company authority once its holder is in no team of the workspace. Lock order: workspace,
-- then the admin row, as in set_workspace_authority. It never raises, so no member removal is
-- blocked, and it leaves level, areas and plan access as they were; a re-invitation restores nothing.
CREATE FUNCTION app.suspend_workspace_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  company uuid;
BEGIN
  FOR company IN SELECT a.workspace_id FROM app.workspace_admins a
      WHERE a.user_id = OLD.user_id AND a.suspended_at IS NULL LOOP
    PERFORM 1 FROM app.workspaces w WHERE w.id = company FOR UPDATE;
    PERFORM 1 FROM app.workspace_admins a WHERE a.workspace_id = company AND a.user_id = OLD.user_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
        WHERE m.user_id = OLD.user_id AND t.workspace_id = company) THEN
      UPDATE app.workspace_admins a SET suspended_at = clock_timestamp()
        WHERE a.workspace_id = company AND a.user_id = OLD.user_id AND a.suspended_at IS NULL;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.suspend_workspace_authority() FROM PUBLIC;
CREATE TRIGGER workspace_suspend_authority AFTER DELETE ON auth.member
  FOR EACH ROW EXECUTE FUNCTION app.suspend_workspace_authority();

-- Company owner sessions only: grants, changes or (with a null level) removes one member's company
-- authority in the workspace of the context's team, and returns whether anything changed. Workspace
-- and actor come from the verified context. 42501 for any other caller, 22023 for invalid arguments,
-- RQ006 for a grant to someone in no team of the workspace, RQ005 for the last unsuspended owner.
-- Every change, including clearing a suspension, writes one workspace-authority activity row.
CREATE FUNCTION tenant_context.set_workspace_authority(target_user_id text, new_level text, new_areas text[],
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
        ELSE new_areas <@ ARRAY['fields','workflows','boards','organisation','templates'] END
    ELSE false END;
  IF valid IS NOT TRUE THEN
    RAISE EXCEPTION 'Workspace authority rejected' USING ERRCODE = '22023';
  END IF;
  IF new_level IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.member m
       JOIN app.workspace_teams t ON t.team_id = m.organization_id
       WHERE m.user_id = target_user_id AND t.workspace_id = company) THEN
    RAISE EXCEPTION 'The member is in no team of this company' USING ERRCODE = 'RQ006';
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
REVOKE ALL ON FUNCTION tenant_context.set_workspace_authority(text, text, text[], boolean) FROM PUBLIC;

-- As in 0026, plus: workspace-authority rows come only from the owner (the helper above); no runtime
-- role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
    OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied', 'mcp.cv_text_read') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'api-token' AND action = 'token.revoked' AND actor_type = 'token'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'export' AND action = 'records.exported' AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'storage-settings' AND action = 'storage.settings_updated' AND actor_type = 'session'
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'account-security' AND action = 'two_step.reset' AND actor_type = 'session'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'workspace-authority' AND action = 'workspace_authority.changed' AND actor_type = 'session' AND token_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The code now depends on these tables and helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 7;
