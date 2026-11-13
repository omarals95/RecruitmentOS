-- Employee erasure and the retention hook (R2a-15, job 057). Apply after 0035_member_roles.sql, then
-- rerun infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.erase_employee and nothing on app.employee_erasures. A company owner session
-- permanently erases one employee of the derived workspace through the owner-run helper: the employee
-- row and its position history go, the user link with them (one scope.home_units_changed row), and
-- every activity row about the employee is redacted to type, time and actor, pointing to a tombstone
-- that holds no personal data. Employees gain a retention class and the time they left, for the
-- company owners' retention review; nothing is erased automatically. app.prevent_activity_mutation(),
-- app.audit_directory_change() and the app.activity insert policy are replaced. The storage schema
-- marker goes to 15, so startup refuses a database without this migration.

-- Only the id, workspace, employee id, erasing owner, time and source. Owner-only: no runtime role
-- reads or writes it.
CREATE TABLE app.employee_erasures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  employee_id uuid NOT NULL,
  erased_by text NOT NULL REFERENCES auth."user"(id),
  erased_at timestamptz NOT NULL,
  erasure_source text NOT NULL CHECK (erasure_source IN ('app', 'script')),
  UNIQUE (workspace_id, employee_id)
);
ALTER TABLE app.employee_erasures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.employee_erasures FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.employee_erasures FROM PUBLIC;

ALTER TABLE app.activity ADD COLUMN employee_erasure_id uuid,
  ADD CONSTRAINT activity_employee_erasure_fkey FOREIGN KEY (employee_erasure_id) REFERENCES app.employee_erasures(id);
CREATE INDEX activity_employee_erasure_idx ON app.activity(employee_erasure_id) WHERE employee_erasure_id IS NOT NULL;

-- The retention class is shown only; nothing enforces it until the owner can set retention periods
-- (R1.5). left_at is set by the service when the status becomes left; existing rows keep null, which
-- reads as updated_at for a left employee.
ALTER TABLE app.employees ADD COLUMN retention_class text NOT NULL DEFAULT 'standard',
  ADD COLUMN left_at timestamptz,
  ADD CONSTRAINT employees_retention_class_check CHECK (retention_class IN ('standard', 'extended'));

-- As in 0021, plus the employee erasure helper's redaction: it sets employee_erasure_id once and
-- replaces summary and metadata. Id, team, actor, token, action, kind, time, record and candidate
-- tombstone never change.
CREATE OR REPLACE FUNCTION app.prevent_activity_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND OLD.erasure_id IS NULL AND NEW.erasure_id IS NOT NULL AND NEW.record_id IS NULL
     AND (NEW.id, NEW.team_id, NEW.actor_id, NEW.actor_type, NEW.token_id, NEW.action, NEW.kind, NEW.created_at)
       IS NOT DISTINCT FROM (OLD.id, OLD.team_id, OLD.actor_id, OLD.actor_type, OLD.token_id, OLD.action, OLD.kind, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND OLD.employee_erasure_id IS NULL AND NEW.employee_erasure_id IS NOT NULL
     AND (NEW.id, NEW.team_id, NEW.actor_id, NEW.actor_type, NEW.token_id, NEW.action, NEW.kind, NEW.created_at, NEW.record_id, NEW.erasure_id)
       IS NOT DISTINCT FROM (OLD.id, OLD.team_id, OLD.actor_id, OLD.actor_type, OLD.token_id, OLD.action, OLD.kind, OLD.created_at, OLD.record_id, OLD.erasure_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Activity history is append-only';
END $$;

-- As in 0035, plus: every runtime branch needs employee_erasure_id null, and only the helper below
-- inserts the employee-erasure row that names an employee tombstone.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'config' AND action IN ('config.draft_created', 'config.published', 'config.retired', 'config.archived', 'config.layout_changed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'org' AND action IN ('org.level_created', 'org.level_renamed', 'org.level_archived', 'org.unit_created',
        'org.unit_renamed', 'org.unit_moved', 'org.unit_archived', 'org.position_created', 'org.position_updated', 'org.position_archived')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'scope' AND action = 'scope.home_units_changed'
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'directory' AND action IN ('directory.employee_created', 'directory.employee_updated', 'directory.employee_archived',
        'directory.employee_positions_changed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'role-assignment' AND action IN ('role.assigned', 'role.cleared')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND employee_erasure_id IS NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'employee-erasure' AND action = 'employee.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- As in 0034, plus: the deletion of a position row of an erased employee (the helper below) writes
-- nothing, and the retention class is a field name like the others (an insert names it only when it
-- is not standard, so a default insert keeps the earlier field list).
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
REVOKE ALL ON FUNCTION app.audit_directory_change() FROM PUBLIC;

-- Owner-only access for the helper below: it reads and writes the tombstones. The owner-only
-- policies of 0021 (activity SELECT and UPDATE) and 0034 (the directory tables) cover the rest.
DO $employee_erasure_policies$ DECLARE command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
  FOREACH command IN ARRAY ARRAY['SELECT', 'INSERT'] LOOP
    EXECUTE format('CREATE POLICY %I ON app.employee_erasures FOR %s %s', 'erasure_owner_' || lower(command), command,
      CASE command WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only) ELSE format('USING (%s)', owner_only) END);
  END LOOP;
END $employee_erasure_policies$;

-- Session contexts whose derived company level is owner only (42501 otherwise: token, OAuth and MCP
-- contexts, company admins, and team owners or admins without company authority), in a read
-- committed transaction like the directory triggers. Workspace, team and actor come from the
-- verified context and every statement filters by them. Returns null when the workspace has no such
-- employee, the earlier result when it was already erased, and otherwise the tombstone and counts;
-- never a name, email, phone or employee number. It touches no position, unit, level, record or
-- other employee.
CREATE FUNCTION tenant_context.erase_employee(target uuid, confirm_name text, erasure_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  subject app.employees%ROWTYPE;
  earlier app.employee_erasures%ROWTYPE;
  earlier_counts jsonb;
  tombstone uuid := gen_random_uuid();
  erased_time timestamptz;
  position_rows integer;
  redacted integer;
  removed jsonb;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS DISTINCT FROM 'owner' OR ctx.workspace_id IS NULL
     OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Employee erasure rejected' USING ERRCODE = '42501';
  END IF;
  IF target IS NULL OR erasure_source IS NULL OR erasure_source NOT IN ('app', 'script') THEN
    RAISE EXCEPTION 'Employee erasure rejected' USING ERRCODE = '22023';
  END IF;
  -- A concurrent erasure of the same employee waits here, then finds the row gone and the tombstone.
  SELECT * INTO subject FROM app.employees e
    WHERE e.id = target AND e.workspace_id = ctx.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO earlier FROM app.employee_erasures x
      WHERE x.workspace_id = ctx.workspace_id AND x.employee_id = target;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT a.metadata INTO earlier_counts FROM app.activity a
      WHERE a.employee_erasure_id = earlier.id AND a.kind = 'employee-erasure' AND a.action = 'employee.erased';
    RETURN jsonb_build_object('erasureId', earlier.id, 'alreadyErased', true, 'erasedAt', earlier.erased_at,
      'removed', jsonb_build_object('positionRows', earlier_counts->'positionRows',
        'activityRedacted', earlier_counts->'activityRedacted', 'userLinks', earlier_counts->'userLinks'));
  END IF;
  IF btrim(coalesce(confirm_name, '')) = '' OR btrim(confirm_name) <> btrim(subject.display_name) THEN
    RAISE EXCEPTION 'Employee erasure confirmation mismatch' USING ERRCODE = 'RQ003';
  END IF;

  erased_time := clock_timestamp();
  -- First, so app.audit_directory_change writes nothing for the position rows deleted next.
  INSERT INTO app.employee_erasures(id, workspace_id, employee_id, erased_by, erased_at, erasure_source)
    VALUES (tombstone, ctx.workspace_id, target, ctx.actor_id, erased_time, erasure_source);
  DELETE FROM app.employee_positions ep WHERE ep.workspace_id = ctx.workspace_id AND ep.employee_id = target;
  GET DIAGNOSTICS position_rows = ROW_COUNT;
  DELETE FROM app.employees e WHERE e.workspace_id = ctx.workspace_id AND e.id = target;
  -- The directory and scope rows about the employee, in every team of the workspace.
  UPDATE app.activity a SET employee_erasure_id = tombstone, summary = 'Details removed by employee erasure',
    metadata = '{}'
    WHERE a.team_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id)
      AND a.metadata->>'employeeId' = target::text AND a.employee_erasure_id IS NULL;
  GET DIAGNOSTICS redacted = ROW_COUNT;
  -- Removing the user link changes that member's home units (architecture 6.5).
  IF subject.user_id IS NOT NULL THEN
    INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
    VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'scope.home_units_changed', 'scope',
      'Changed the employee facts that set home units',
      jsonb_build_object('workspaceId', ctx.workspace_id, 'affectedUserIds', jsonb_build_array(subject.user_id)));
  END IF;
  removed := jsonb_build_object('positionRows', position_rows, 'activityRedacted', redacted,
    'userLinks', CASE WHEN subject.user_id IS NULL THEN 0 ELSE 1 END);
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata,
    employee_erasure_id, created_at)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'employee.erased', 'employee-erasure',
    'Permanently erased an employee',
    jsonb_build_object('source', erasure_source, 'workspaceId', ctx.workspace_id) || removed, tombstone, erased_time);
  RETURN jsonb_build_object('erasureId', tombstone, 'alreadyErased', false, 'erasedAt', erased_time,
    'removed', removed);
END $$;
REVOKE ALL ON FUNCTION tenant_context.erase_employee(uuid, text, text) FROM PUBLIC;

-- The code now depends on the tombstone table, the employee columns and the helper; startup refuses
-- a database without them.
UPDATE db_boundary.storage_schema SET version = 15;
