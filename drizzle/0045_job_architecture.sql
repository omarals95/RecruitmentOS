-- Job families, titles and grades (ADM-24, job 079). Apply after 0044_team_archive.sql; the role
-- template is unchanged and needs no rerun (infrastructure/postgres-split-runtime-roles.sql,
-- scripts/runtime-role-template.ts and src/db/connection-boundary.ts are unchanged): the data role's
-- table-level SELECT, INSERT and UPDATE on app.positions already cover the new column, and CREATE OR
-- REPLACE keeps the helpers' signatures, owners and grants. The configuration store gains the type
-- job-architecture, one company object written under the organisation area like units and positions,
-- and positions gain a nullable job title key, a configuration key checked by the service against
-- the published version. No row is rewritten: every existing position keeps a null key. The storage
-- schema marker goes to 23, so startup refuses a database without this migration.

-- A configuration key only (null allowed), never a record value.
ALTER TABLE app.positions ADD COLUMN job_title_key text
  CONSTRAINT positions_job_title_key_check CHECK (job_title_key ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- As in 0030, plus job-architecture.
ALTER TABLE app.config_objects DROP CONSTRAINT config_objects_type_check,
  ADD CONSTRAINT config_objects_type_check
    CHECK (type IN ('kind-schema','workflow','board','role','template','task-board','job-architecture'));

-- The runtime policies of 0030, with job-architecture written under organisation. The owner-only
-- config_owner_* policies are unchanged.
DO $config_rls$ DECLARE tbl text; access text;
  -- %1$s is the object row prefix, %2$L the access. Roles need a company owner (allows_workspace).
  object_rule text := 'tenant_context.allows_workspace(%1$sworkspace_id, %2$L, CASE %1$stype WHEN ''kind-schema'' THEN ''fields'' '
    'WHEN ''workflow'' THEN ''workflows'' WHEN ''board'' THEN ''boards'' WHEN ''template'' THEN ''templates'' '
    'WHEN ''role'' THEN ''roles'' WHEN ''task-board'' THEN ''task-board'' WHEN ''job-architecture'' THEN ''organisation'' END) '
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

-- As in 0030, plus job-architecture under organisation. CREATE OR REPLACE keeps its grants.
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
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' WHEN 'job-architecture' THEN 'organisation' END) THEN
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

-- As in 0030, plus job-architecture under organisation. CREATE OR REPLACE keeps its grants.
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
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' WHEN 'job-architecture' THEN 'organisation' END) THEN
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

-- As in 0030, plus job-architecture under organisation. CREATE OR REPLACE keeps its grants.
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
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' WHEN 'job-architecture' THEN 'organisation' END) THEN
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

-- As in 0036, plus the job title key as a field name like the others: a position insert names it
-- only when it is set, so an insert without one keeps the earlier field list. Never its value.
CREATE OR REPLACE FUNCTION app.audit_directory_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
  fields text[] := '{}';
  actions text[] := '{}';
  action text;
  subject jsonb;
  affected text[];
  latest uuid;
  metadata jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned())
     AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Organisation and directory changes need a read committed transaction' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_workspace := OLD.workspace_id;
  ELSE
    row_workspace := NEW.workspace_id;
  END IF;
  -- Nested, because OLD.employee_id exists only for position rows.
  IF TG_TABLE_NAME = 'employee_positions' AND TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM app.employee_erasures x
        WHERE x.workspace_id = OLD.workspace_id AND x.employee_id = OLD.employee_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'positions' THEN
    subject := jsonb_build_object('positionId', NEW.id);
    IF TG_OP = 'INSERT' THEN
      fields := ARRAY['code', 'isManager', 'orgUnitId', 'title'];
      IF NEW.job_role_id IS NOT NULL THEN
        fields := array_append(fields, 'jobRoleId');
      END IF;
      IF NEW.job_title_key IS NOT NULL THEN
        fields := array_append(fields, 'jobTitleKey');
      END IF;
      actions := ARRAY['org.position_created'];
      SELECT l.id INTO latest FROM (SELECT p.id, p.org_unit_id FROM app.positions p
          WHERE p.workspace_id = NEW.workspace_id AND p.code = NEW.code AND p.id <> NEW.id
          ORDER BY p.valid_from DESC, p.id DESC LIMIT 1) l
        WHERE l.org_unit_id IS DISTINCT FROM NEW.org_unit_id;
    ELSE
      IF NEW.title IS DISTINCT FROM OLD.title THEN
        fields := array_append(fields, 'title');
      END IF;
      IF NEW.code IS DISTINCT FROM OLD.code THEN
        fields := array_append(fields, 'code');
      END IF;
      IF NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id THEN
        fields := array_append(fields, 'orgUnitId');
      END IF;
      IF (NEW.job_role_team_id, NEW.job_role_id) IS DISTINCT FROM (OLD.job_role_team_id, OLD.job_role_id) THEN
        fields := array_append(fields, 'jobRoleId');
      END IF;
      IF NEW.job_title_key IS DISTINCT FROM OLD.job_title_key THEN
        fields := array_append(fields, 'jobTitleKey');
      END IF;
      IF NEW.is_manager IS DISTINCT FROM OLD.is_manager THEN
        fields := array_append(fields, 'isManager');
      END IF;
      IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
        fields := array_append(fields, 'validTo');
      END IF;
      IF cardinality(fields) > 0 THEN
        actions := ARRAY['org.position_updated'];
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := array_append(actions, 'org.position_archived');
      END IF;
      IF NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        latest := NEW.id;
      END IF;
    END IF;
    IF latest IS NOT NULL THEN
      affected := ARRAY(SELECT DISTINCT e.user_id COLLATE "C" FROM app.employee_positions ep
        JOIN app.employees e ON e.id = ep.employee_id AND e.workspace_id = ep.workspace_id
        WHERE ep.workspace_id = row_workspace AND ep.position_id = latest AND ep.valid_to IS NULL
          AND e.user_id IS NOT NULL ORDER BY 1);
    END IF;
  ELSIF TG_TABLE_NAME = 'employees' THEN
    subject := jsonb_build_object('employeeId', NEW.id);
    IF TG_OP = 'INSERT' THEN
      fields := ARRAY['displayName', 'employeeNumber', 'status'];
      IF NEW.user_id IS NOT NULL THEN
        fields := array_append(fields, 'userId');
        affected := ARRAY[NEW.user_id];
      END IF;
      IF NEW.work_email IS NOT NULL THEN
        fields := array_append(fields, 'workEmail');
      END IF;
      IF NEW.work_phone IS NOT NULL THEN
        fields := array_append(fields, 'workPhone');
      END IF;
      IF NEW.retention_class IS DISTINCT FROM 'standard' THEN
        fields := array_append(fields, 'retentionClass');
      END IF;
      actions := ARRAY['directory.employee_created'];
    ELSE
      IF NEW.display_name IS DISTINCT FROM OLD.display_name THEN
        fields := array_append(fields, 'displayName');
      END IF;
      IF NEW.employee_number IS DISTINCT FROM OLD.employee_number THEN
        fields := array_append(fields, 'employeeNumber');
      END IF;
      IF NEW.work_email IS DISTINCT FROM OLD.work_email THEN
        fields := array_append(fields, 'workEmail');
      END IF;
      IF NEW.work_phone IS DISTINCT FROM OLD.work_phone THEN
        fields := array_append(fields, 'workPhone');
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        fields := array_append(fields, 'status');
      END IF;
      IF NEW.retention_class IS DISTINCT FROM OLD.retention_class THEN
        fields := array_append(fields, 'retentionClass');
      END IF;
      IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        fields := array_append(fields, 'userId');
        affected := ARRAY(SELECT DISTINCT u COLLATE "C" FROM unnest(ARRAY[OLD.user_id, NEW.user_id]) u
          WHERE u IS NOT NULL ORDER BY 1);
      END IF;
      IF cardinality(fields) > 0 THEN
        actions := ARRAY['directory.employee_updated'];
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := array_append(actions, 'directory.employee_archived');
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      subject := jsonb_build_object('employeeId', OLD.employee_id, 'positionId', OLD.position_id);
      fields := ARRAY['positionId'];
    ELSIF TG_OP = 'INSERT' THEN
      subject := jsonb_build_object('employeeId', NEW.employee_id, 'positionId', NEW.position_id);
      fields := ARRAY['positionId', 'primary'];
    ELSE
      subject := jsonb_build_object('employeeId', NEW.employee_id, 'positionId', NEW.position_id);
      IF NEW."primary" IS DISTINCT FROM OLD."primary" THEN
        fields := array_append(fields, 'primary');
      END IF;
      IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
        fields := array_append(fields, 'validTo');
      END IF;
    END IF;
    IF cardinality(fields) > 0 THEN
      actions := ARRAY['directory.employee_positions_changed'];
      affected := ARRAY(SELECT e.user_id FROM app.employees e
        WHERE e.workspace_id = row_workspace AND e.id = (subject->>'employeeId')::uuid AND e.user_id IS NOT NULL);
    END IF;
  END IF;
  IF cardinality(affected) > 0 THEN
    actions := array_append(actions, 'scope.home_units_changed');
  END IF;
  fields := ARRAY(SELECT f COLLATE "C" FROM unnest(fields) f ORDER BY 1);
  FOREACH action IN ARRAY actions LOOP
    IF action = 'scope.home_units_changed' THEN
      metadata := jsonb_build_object('workspaceId', row_workspace, 'affectedUserIds', to_jsonb(affected))
        || CASE WHEN subject->>'employeeId' IS NULL THEN subject
          ELSE jsonb_build_object('employeeId', subject->'employeeId') END;
    ELSIF action IN ('org.position_archived', 'directory.employee_archived') THEN
      metadata := jsonb_build_object('workspaceId', row_workspace, 'fields', to_jsonb(ARRAY['archivedAt'])) || subject;
    ELSE
      metadata := jsonb_build_object('workspaceId', row_workspace, 'fields', to_jsonb(fields)) || subject;
    END IF;
    INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
    VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, action, split_part(action, '.', 1),
      CASE action
        WHEN 'org.position_created' THEN 'Created a position'
        WHEN 'org.position_updated' THEN 'Updated a position'
        WHEN 'org.position_archived' THEN 'Archived a position'
        WHEN 'directory.employee_created' THEN 'Created an employee'
        WHEN 'directory.employee_updated' THEN 'Updated an employee'
        WHEN 'directory.employee_archived' THEN 'Archived an employee'
        WHEN 'directory.employee_positions_changed' THEN 'Changed an employee''s positions'
        ELSE 'Changed the employee facts that set home units' END,
      metadata);
  END LOOP;
  RETURN NULL;
END $$;

-- The code now reads and writes the job architecture and the job title key; startup refuses a
-- database without them.
UPDATE db_boundary.storage_schema SET version = 23;
