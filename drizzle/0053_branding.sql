-- Branding model and design tokens (ADM-36, job 097). Apply after 0052_company_groups.sql, then
-- rerun infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on the
-- new tenant_context.public_branding; the identity role gets nothing. The configuration store gains
-- the type branding, one company object keyed company and written under the new grantable company
-- area branding (D20), which joins the area check of app.workspace_admins,
-- tenant_context.set_workspace_authority and tenant_context.allows_workspace. Every context of the
-- workspace reads published branding rows, as for the other areas but people. The owner-run
-- tenant_context.public_branding returns, with no tenant context, only the public token set of the
-- environment workspace's published branding (colours, the two asset ids and the sign-in message),
-- for the root layout and the sign-in page (BRD-011, TST-018). CREATE OR REPLACE keeps the
-- re-bodied helpers' signatures, owners and grants. No existing row is rewritten. The storage schema
-- marker goes to 31, so startup refuses a database without this migration.

-- As in 0045, plus branding.
ALTER TABLE app.config_objects DROP CONSTRAINT config_objects_type_check,
  ADD CONSTRAINT config_objects_type_check
    CHECK (type IN ('kind-schema','workflow','board','role','template','task-board','job-architecture','branding'));

-- The runtime policies of 0045, with branding written under branding. The owner-only
-- config_owner_* policies are unchanged.
DO $config_rls$ DECLARE tbl text; access text;
  -- %1$s is the object row prefix, %2$L the access. Roles need a company owner (allows_workspace).
  object_rule text := 'tenant_context.allows_workspace(%1$sworkspace_id, %2$L, CASE %1$stype WHEN ''kind-schema'' THEN ''fields'' '
    'WHEN ''workflow'' THEN ''workflows'' WHEN ''board'' THEN ''boards'' WHEN ''template'' THEN ''templates'' '
    'WHEN ''role'' THEN ''roles'' WHEN ''task-board'' THEN ''task-board'' WHEN ''job-architecture'' THEN ''organisation'' '
    'WHEN ''branding'' THEN ''branding'' END) '
    'AND (%1$steam_id IS NULL OR tenant_context.allows(%1$steam_id, NULL, ''read''))';
  rules text[];
BEGIN
 FOREACH tbl IN ARRAY ARRAY['config_objects','config_versions','config_layouts'] LOOP
  -- Runtime contexts: versions and layouts take the type and team of their object.
  rules := ARRAY[]::text[];
  FOREACH access IN ARRAY ARRAY['read','write'] LOOP
   rules := rules || CASE tbl
     WHEN 'config_objects' THEN format(object_rule, '', access)
     WHEN 'config_versions' THEN format('EXISTS (SELECT 1 FROM app.config_objects o WHERE o.id = config_versions.object_id '
       'AND o.workspace_id = config_versions.workspace_id AND %s)', format(object_rule, 'o.', access))
     ELSE format('EXISTS (SELECT 1 FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id '
       'WHERE v.id = config_layouts.version_id AND v.workspace_id = config_layouts.workspace_id AND %s)',
       format(object_rule, 'o.', access)) END;
  END LOOP;
  EXECUTE format('DROP POLICY context_read ON app.%I', tbl);
  EXECUTE format('DROP POLICY context_insert ON app.%I', tbl);
  EXECUTE format('DROP POLICY context_update ON app.%I', tbl);
  EXECUTE format('DROP POLICY context_delete ON app.%I', tbl);
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (%s)', tbl, rules[1]);
  EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', tbl, rules[2]);
  EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, rules[2], rules[2]);
  EXECUTE format('CREATE POLICY context_delete ON app.%I FOR DELETE USING (%s)', tbl, rules[2]);
 END LOOP;
END $config_rls$;

-- As in 0045, plus branding under branding. CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.audit_config(version_id uuid, action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  ver app.config_versions%ROWTYPE;
  obj app.config_objects%ROWTYPE;
  from_version uuid;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF FOUND THEN
    SELECT * INTO ver FROM app.config_versions v
      WHERE v.id = audit_config.version_id AND v.workspace_id = ctx.workspace_id;
    SELECT * INTO obj FROM app.config_objects o WHERE o.id = ver.object_id;
  END IF;
  IF obj.id IS NULL OR (obj.team_id IS NOT NULL AND obj.team_id <> ctx.team_id)
     OR NOT tenant_context.allows_workspace(obj.workspace_id, 'write', CASE obj.type WHEN 'kind-schema' THEN 'fields'
       WHEN 'workflow' THEN 'workflows' WHEN 'board' THEN 'boards' WHEN 'template' THEN 'templates'
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' WHEN 'job-architecture' THEN 'organisation'
       WHEN 'branding' THEN 'branding' END) THEN
    RAISE EXCEPTION 'Configuration audit rejected' USING ERRCODE = '42501';
  END IF;
  IF audit_config.action IS NULL OR audit_config.action NOT IN ('config.draft_created', 'config.published',
       'config.retired', 'config.archived', 'config.layout_changed') THEN
    RAISE EXCEPTION 'Configuration audit rejected' USING ERRCODE = '22023';
  END IF;
  IF NOT (CASE audit_config.action
       WHEN 'config.draft_created' THEN ver.state = 'draft'
       WHEN 'config.published' THEN ver.state = 'published'
       WHEN 'config.retired' THEN ver.state = 'retired'
       WHEN 'config.archived' THEN obj.archived_at IS NOT NULL
       ELSE EXISTS (SELECT 1 FROM app.config_layouts l WHERE l.version_id = ver.id) END)
     OR EXISTS (SELECT 1 FROM app.activity a WHERE a.kind = 'config' AND a.metadata->>'objectId' = obj.id::text
       AND a.action = audit_config.action AND CASE audit_config.action
         WHEN 'config.archived' THEN true
         WHEN 'config.layout_changed' THEN false
         ELSE a.metadata->>'versionId' = ver.id::text END) THEN
    RAISE EXCEPTION 'The configuration rows do not match this change' USING ERRCODE = 'RQ007';
  END IF;
  -- Each publish makes the new version current, so the version published before is number - 1.
  from_version := CASE audit_config.action
    WHEN 'config.draft_created' THEN obj.current_version_id
    WHEN 'config.published' THEN (SELECT v.id FROM app.config_versions v WHERE v.object_id = obj.id AND v.number = ver.number - 1)
    END;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, audit_config.action, 'config',
    CASE audit_config.action
      WHEN 'config.draft_created' THEN 'Created a configuration draft'
      WHEN 'config.published' THEN 'Published a configuration version'
      WHEN 'config.retired' THEN 'Retired a configuration version'
      WHEN 'config.archived' THEN 'Archived a configuration object'
      ELSE 'Changed a configuration layout' END,
    jsonb_build_object('workspaceId', obj.workspace_id, 'objectId', obj.id, 'type', obj.type, 'key', obj.key,
      'versionId', ver.id, 'number', ver.number, 'fromVersionId', from_version));
END $$;

-- As in 0045, plus branding under branding. CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.publish_config_version(version_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  obj app.config_objects%ROWTYPE;
  next_number integer;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF FOUND THEN
    SELECT o.* INTO obj FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id
      WHERE v.id = publish_config_version.version_id AND v.workspace_id = ctx.workspace_id;
  END IF;
  IF obj.id IS NULL OR (obj.team_id IS NOT NULL AND obj.team_id <> ctx.team_id)
     OR NOT tenant_context.allows_workspace(obj.workspace_id, 'write', CASE obj.type WHEN 'kind-schema' THEN 'fields'
       WHEN 'workflow' THEN 'workflows' WHEN 'board' THEN 'boards' WHEN 'template' THEN 'templates'
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' WHEN 'job-architecture' THEN 'organisation'
       WHEN 'branding' THEN 'branding' END) THEN
    RAISE EXCEPTION 'Configuration publish rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO obj FROM app.config_objects o WHERE o.id = obj.id FOR UPDATE;
  IF obj.archived_at IS NOT NULL OR obj.draft_version_id IS DISTINCT FROM publish_config_version.version_id
     OR NOT EXISTS (SELECT 1 FROM app.config_versions v WHERE v.id = publish_config_version.version_id AND v.state = 'draft') THEN
    RAISE EXCEPTION 'Only the draft of an active configuration object can be published' USING ERRCODE = 'RQ007';
  END IF;
  SELECT coalesce(max(v.number), 0) + 1 INTO next_number FROM app.config_versions v WHERE v.object_id = obj.id;
  UPDATE app.config_versions v SET state = 'published', number = next_number, published_by = ctx.actor_id,
    published_at = clock_timestamp() WHERE v.id = publish_config_version.version_id;
  UPDATE app.config_objects o SET current_version_id = publish_config_version.version_id, draft_version_id = NULL
    WHERE o.id = obj.id;
  PERFORM tenant_context.audit_config(publish_config_version.version_id, 'config.published');
  RETURN next_number;
END $$;

-- As in 0045, plus branding under branding. CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.retire_config_version(version_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  obj app.config_objects%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF FOUND THEN
    SELECT o.* INTO obj FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id
      WHERE v.id = retire_config_version.version_id AND v.workspace_id = ctx.workspace_id;
  END IF;
  IF obj.id IS NULL OR (obj.team_id IS NOT NULL AND obj.team_id <> ctx.team_id)
     OR NOT tenant_context.allows_workspace(obj.workspace_id, 'write', CASE obj.type WHEN 'kind-schema' THEN 'fields'
       WHEN 'workflow' THEN 'workflows' WHEN 'board' THEN 'boards' WHEN 'template' THEN 'templates'
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' WHEN 'job-architecture' THEN 'organisation'
       WHEN 'branding' THEN 'branding' END) THEN
    RAISE EXCEPTION 'Configuration retire rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO obj FROM app.config_objects o WHERE o.id = obj.id FOR UPDATE;
  IF obj.current_version_id IS NOT DISTINCT FROM retire_config_version.version_id
     OR NOT EXISTS (SELECT 1 FROM app.config_versions v WHERE v.id = retire_config_version.version_id AND v.state = 'published') THEN
    RAISE EXCEPTION 'Only a published version that is not current can be retired' USING ERRCODE = 'RQ007';
  END IF;
  UPDATE app.config_versions v SET state = 'retired' WHERE v.id = retire_config_version.version_id;
  PERFORM tenant_context.audit_config(retire_config_version.version_id, 'config.retired');
END $$;

-- As in 0052, plus the branding area: every context of the workspace reads it, and a session that
-- is company owner or holds branding writes it, as for the other areas. CREATE OR REPLACE keeps its
-- grants.
CREATE OR REPLACE FUNCTION tenant_context.allows_workspace(row_workspace uuid, access text, area text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace
      AND area IN ('fields','workflows','boards','organisation','templates','roles','task-board','people','branding')
      AND CASE access
        WHEN 'read' THEN area <> 'people' OR (c.auth_type = 'session'
          AND (c.company_level = 'owner' OR (c.company_level = 'admin' AND 'people' = ANY(c.company_areas))))
        WHEN 'write' THEN c.auth_type = 'session' AND CASE area
          WHEN 'roles' THEN c.company_level = 'owner'
          WHEN 'task-board' THEN c.member_role IN ('owner','admin')
            AND NOT EXISTS (SELECT 1 FROM app.workspace_teams t WHERE t.team_id = c.team_id AND t.archived_at IS NOT NULL)
          ELSE c.company_level = 'owner' OR area = ANY(c.company_areas) END
        ELSE false END)
$$;

-- As in 0042, plus branding. Existing rows hold only the earlier areas, so they stay valid.
ALTER TABLE app.workspace_admins DROP CONSTRAINT workspace_admins_areas_check,
  ADD CONSTRAINT workspace_admins_areas_check CHECK (array_position(areas, NULL) IS NULL AND CASE level
    WHEN 'owner' THEN areas = '{}'
    ELSE areas <@ ARRAY['fields','workflows','boards','organisation','templates','people','branding']
      AND cardinality(array_positions(areas, 'fields')) <= 1
      AND cardinality(array_positions(areas, 'workflows')) <= 1
      AND cardinality(array_positions(areas, 'boards')) <= 1
      AND cardinality(array_positions(areas, 'organisation')) <= 1
      AND cardinality(array_positions(areas, 'templates')) <= 1
      AND cardinality(array_positions(areas, 'people')) <= 1
      AND cardinality(array_positions(areas, 'branding')) <= 1 END);

-- As in 0047, except that an admin may also hold branding. CREATE OR REPLACE keeps its grants.
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
        ELSE new_areas <@ ARRAY['fields','workflows','boards','organisation','templates','people','branding'] END
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
       AND a.user_id <> target_user_id AND a.level = 'owner' AND a.suspended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = company
         AND d.user_id = a.user_id AND d.deactivated_at IS NOT NULL)) THEN
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

-- The public token set shown before sign-in (BRD-011, TST-018): with no tenant context, the current
-- published version of the environment workspace's company branding (one workspace per environment,
-- D1 and D15), and from its body only the colours, the two asset ids and the sign-in message; keys
-- the body lacks are left out. Never a draft, the email header, another id, a number, an actor, a
-- time, a note, a hash or any other table's data. NULL when nothing is published. Writes nothing.
CREATE FUNCTION tenant_context.public_branding() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('accent', v.body->'accent', 'palette', v.body->'palette',
    'light', v.body->'light', 'dark', v.body->'dark', 'logoAssetId', v.body->'logoAssetId',
    'faviconAssetId', v.body->'faviconAssetId', 'signInMessage', v.body->'signInMessage'))
  FROM app.config_objects o JOIN app.config_versions v ON v.id = o.current_version_id AND v.object_id = o.id
  WHERE o.workspace_id = '00000000-0000-4000-a000-000000000001'::uuid AND o.team_id IS NULL
    AND o.type = 'branding' AND o.key = 'company' AND o.archived_at IS NULL AND v.state = 'published'
$$;
REVOKE ALL ON FUNCTION tenant_context.public_branding() FROM PUBLIC;

-- The code now reads and writes branding and the branding area; startup refuses a database without
-- them.
UPDATE db_boundary.storage_schema SET version = 31;
