-- Delegated group managers, archive with replacement and archived groups (ADM-13, job 099). Apply
-- after 0054_domain_audit.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which
-- grants the data role EXECUTE on tenant_context.manages_group; the identity role gets nothing. A
-- user named in app.group_managers manages that group without any company authority (T-R2-19): new
-- manager policies, all built on manages_group, let a session of theirs read the groups they manage,
-- their own manager rows and those groups' user member rows, and insert and delete those user member
-- rows, never a child group row, a manager row or a group row, and nothing of
-- app.group_effective_members. app.guard_group_write() gets a new body: a manager's write is admitted
-- only while the group grants nothing (tenant_context.group_grants, D20) and is not archived, so a
-- group that starts granting after they were named refuses them (42501); an archived group takes no
-- new member, child or manager, and is nobody's new child (RQ023); no context names a manager of a
-- group that grants something, a company owner included (42501); and a company owner or a company
-- admin with people may replace a child group in place, the one UPDATE of a member row there is.
-- app.audit_group_change() writes one group.child_replaced row for that UPDATE, and the app.activity
-- insert policy admits it. No existing row is rewritten. The storage schema marker goes to 33, so
-- startup refuses a database without this migration.

-- True only for an unexpired session context of this backend and transaction whose actor has an
-- app.group_managers row for the group in the context's workspace. It reads app.group_managers
-- alone (its workspace_id is the group's, by the composite key), so the manager policies below
-- never re-enter it from app.groups or app.group_members. Reveals that boolean only.
CREATE FUNCTION tenant_context.manages_group(group_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    JOIN app.group_managers r ON r.workspace_id = c.workspace_id AND r.user_id = c.actor_id
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session'
      AND r.group_id = manages_group.group_id)
$$;
REVOKE ALL ON FUNCTION tenant_context.manages_group(uuid) FROM PUBLIC;

-- Permissive, beside context_read and the write policies of 0052. A manager reads the groups they
-- manage, their own manager rows and the user member rows of their groups; they insert and delete
-- those user member rows while the group grants nothing. As in 0052, a delete or update reaches
-- every readable row, so a refused one fails in the guard with 42501 instead of matching no row:
-- the two update policies admit no new row at all (WITH CHECK false), so no manager policy updates,
-- none writes app.groups or app.group_managers, and none reads child group rows or
-- app.group_effective_members. The manager row policy is false for the owner first, so
-- manages_group's own read of app.group_managers, as the owner, never re-enters it.
CREATE POLICY manager_read ON app.groups FOR SELECT USING (tenant_context.manages_group(id));
CREATE POLICY manager_update ON app.groups FOR UPDATE USING (tenant_context.manages_group(id)) WITH CHECK (false);
CREATE POLICY manager_read ON app.group_managers FOR SELECT USING (
  current_user <> (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
  AND tenant_context.context_actor_key() = user_id || ':session:session'
  AND tenant_context.manages_group(group_id));
CREATE POLICY manager_read ON app.group_members FOR SELECT USING (
  user_id IS NOT NULL AND tenant_context.manages_group(group_id));
CREATE POLICY manager_insert ON app.group_members FOR INSERT WITH CHECK (
  user_id IS NOT NULL AND child_group_id IS NULL AND tenant_context.manages_group(group_id)
  AND NOT tenant_context.group_grants(group_id));
CREATE POLICY manager_update ON app.group_members FOR UPDATE USING (
  user_id IS NOT NULL AND tenant_context.manages_group(group_id)) WITH CHECK (false);
CREATE POLICY manager_delete ON app.group_members FOR DELETE USING (
  user_id IS NOT NULL AND tenant_context.manages_group(group_id));

-- As in 0052, with these rules changed. A context below the company owner or people bar is admitted
-- only as a delegated manager: an INSERT or DELETE of a user member row of a group for which
-- manages_group is true, group_grants false and that is not archived, after the workspace row lock,
-- so a group that starts granting serialises with them; anything else is 42501. For every context,
-- an INSERT of a member or manager row into an archived group, or of an archived child group, and an
-- UPDATE that makes an archived group the child, are RQ023; an INSERT of a manager row for a group
-- for which group_grants is true is 42501, a company owner included. A company owner or people
-- context may UPDATE a child row to another child group of the same workspace, changing nothing
-- else (added_at is restamped): the replacement archive uses. Every other member or manager UPDATE
-- stays 42501. CREATE OR REPLACE keeps the triggers.
CREATE OR REPLACE FUNCTION app.guard_group_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
  manager boolean;
  member_group uuid;
  member_user text;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'groups' THEN
    IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND (OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL) THEN
      RAISE EXCEPTION 'An archived group stays archived' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned();
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_workspace := OLD.workspace_id;
  ELSE
    row_workspace := NEW.workspace_id;
  END IF;
  IF ctx.expires_at <= clock_timestamp() OR ctx.auth_type IS DISTINCT FROM 'session' OR ctx.workspace_id IS DISTINCT FROM row_workspace
     OR (TG_OP = 'UPDATE' AND OLD.workspace_id IS DISTINCT FROM row_workspace) THEN
    RAISE EXCEPTION 'Changing groups needs a company owner, or a company admin with the people area' USING ERRCODE = '42501';
  END IF;
  manager := NOT coalesce(ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas)), false);
  IF manager AND (TG_TABLE_NAME <> 'group_members' OR TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'Changing groups needs a company owner, or a company admin with the people area' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = row_workspace FOR NO KEY UPDATE;
  IF manager THEN
    IF TG_OP = 'INSERT' THEN
      member_group := NEW.group_id;
      member_user := NEW.user_id;
    ELSE
      member_group := OLD.group_id;
      member_user := OLD.user_id;
    END IF;
    IF member_user IS NULL OR NOT tenant_context.manages_group(member_group)
       OR EXISTS (SELECT 1 FROM app.groups g WHERE g.id = member_group AND g.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'A group manager only adds and removes the people of a current group they manage' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF ctx.company_level IS DISTINCT FROM 'owner' THEN
    IF TG_TABLE_NAME = 'groups' THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.approval THEN
          RAISE EXCEPTION 'Only a company owner can make an approval group' USING ERRCODE = '42501';
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.approval IS DISTINCT FROM OLD.approval OR tenant_context.group_grants(OLD.id)
           OR tenant_context.group_grants(NEW.id) THEN
          RAISE EXCEPTION 'Only a company owner can change an approval group or a group nested in one' USING ERRCODE = '42501';
        END IF;
      ELSIF tenant_context.group_grants(OLD.id) THEN
        RAISE EXCEPTION 'Only a company owner can change an approval group or a group nested in one' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF TG_OP <> 'INSERT' THEN
        IF tenant_context.group_grants(OLD.group_id) THEN
          RAISE EXCEPTION 'Only a company owner can change an approval group or a group nested in one' USING ERRCODE = '42501';
        END IF;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        IF tenant_context.group_grants(NEW.group_id) THEN
          RAISE EXCEPTION 'Only a company owner can change an approval group or a group nested in one' USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'groups' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'Group row rejected' USING ERRCODE = '42501';
      END IF;
      NEW.created_at := now();
    ELSIF (NEW.id, NEW.workspace_id, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Group row rejected' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM app.groups g WHERE g.id = NEW.group_id AND g.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'An archived group takes no new members' USING ERRCODE = 'RQ023';
  END IF;
  IF TG_TABLE_NAME = 'group_managers' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Group members and managers are added and removed, never changed' USING ERRCODE = '42501';
    END IF;
    IF tenant_context.group_grants(NEW.group_id) THEN
      RAISE EXCEPTION 'A group that grants access cannot have managers' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' THEN
      IF OLD.child_group_id IS NULL OR NEW.child_group_id IS NULL OR NEW.child_group_id = OLD.child_group_id
         OR (NEW.group_id, NEW.workspace_id, NEW.user_id, NEW.added_by)
           IS DISTINCT FROM (OLD.group_id, OLD.workspace_id, OLD.user_id, OLD.added_by) THEN
        RAISE EXCEPTION 'Group members and managers are added and removed, never changed' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM app.groups g WHERE g.id = NEW.child_group_id AND g.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'An archived group takes no new members' USING ERRCODE = 'RQ023';
    END IF;
  END IF;
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
       WHERE m.user_id = NEW.user_id AND t.workspace_id = row_workspace) THEN
    RAISE EXCEPTION 'The member is in no team of this company' USING ERRCODE = 'RQ006';
  END IF;
  IF TG_TABLE_NAME = 'group_members' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.added_by := ctx.actor_id;
    END IF;
    NEW.added_at := now();
  END IF;
  RETURN NEW;
END $$;

-- As in 0052, plus one group.child_replaced row for an UPDATE of a child row: groupId is the parent,
-- childGroupId the replacement and replacedGroupId the group it replaced, ids only.
CREATE OR REPLACE FUNCTION app.audit_group_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  actions text[] := '{}';
  action text;
  changed_row jsonb;
  metadata jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_row := to_jsonb(OLD);
  ELSE
    changed_row := to_jsonb(NEW);
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.workspace_id = (changed_row->>'workspace_id')::uuid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF ctx.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Group change rejected' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'groups' THEN
    IF TG_OP = 'INSERT' THEN
      actions := ARRAY['group.created'];
    ELSIF TG_OP = 'UPDATE' THEN
      IF (NEW.name, NEW.description) IS DISTINCT FROM (OLD.name, OLD.description) THEN
        actions := array_append(actions, 'group.renamed');
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := array_append(actions, 'group.archived');
      END IF;
      IF NEW.approval AND NOT OLD.approval THEN
        actions := array_append(actions, 'group.approval_set');
      ELSIF OLD.approval AND NOT NEW.approval THEN
        actions := array_append(actions, 'group.approval_cleared');
      END IF;
    END IF;
    metadata := jsonb_build_object('workspaceId', changed_row->'workspace_id', 'groupId', changed_row->'id');
  ELSIF TG_OP IN ('INSERT', 'DELETE') THEN
    metadata := jsonb_build_object('workspaceId', changed_row->'workspace_id', 'groupId', changed_row->'group_id');
    IF TG_TABLE_NAME = 'group_managers' THEN
      actions := ARRAY[CASE TG_OP WHEN 'INSERT' THEN 'group.manager_added' ELSE 'group.manager_removed' END];
      metadata := metadata || jsonb_build_object('targetUserId', changed_row->'user_id');
    ELSIF changed_row->>'user_id' IS NOT NULL THEN
      actions := ARRAY[CASE TG_OP WHEN 'INSERT' THEN 'group.member_added' ELSE 'group.member_removed' END];
      metadata := metadata || jsonb_build_object('targetUserId', changed_row->'user_id');
    ELSE
      actions := ARRAY[CASE TG_OP WHEN 'INSERT' THEN 'group.child_added' ELSE 'group.child_removed' END];
      metadata := metadata || jsonb_build_object('childGroupId', changed_row->'child_group_id');
    END IF;
  ELSIF TG_TABLE_NAME = 'group_members' AND changed_row->>'child_group_id' IS NOT NULL THEN
    actions := ARRAY['group.child_replaced'];
    metadata := jsonb_build_object('workspaceId', changed_row->'workspace_id', 'groupId', changed_row->'group_id',
      'childGroupId', changed_row->'child_group_id', 'replacedGroupId', to_jsonb(OLD)->'child_group_id');
  END IF;
  FOREACH action IN ARRAY actions LOOP
    INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
    VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, action, 'group',
      CASE action
        WHEN 'group.created' THEN 'Created a group'
        WHEN 'group.renamed' THEN 'Renamed a group or changed its description'
        WHEN 'group.archived' THEN 'Archived a group'
        WHEN 'group.approval_set' THEN 'Made a group an approval group'
        WHEN 'group.approval_cleared' THEN 'Made a group no longer an approval group'
        WHEN 'group.member_added' THEN 'Added a member to a group'
        WHEN 'group.member_removed' THEN 'Removed a member from a group'
        WHEN 'group.child_added' THEN 'Added a group to a group'
        WHEN 'group.child_removed' THEN 'Removed a group from a group'
        WHEN 'group.child_replaced' THEN 'Replaced a group in a group'
        WHEN 'group.manager_added' THEN 'Added a group manager'
        ELSE 'Removed a group manager' END,
      metadata);
  END LOOP;
  RETURN NULL;
END $$;

-- As in 0054, plus group.child_replaced in the group branch.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND user_anonymisation_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment', 'team-archive', 'user-account', 'salary-brackets', 'user-anonymisation', 'group', 'domain') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'assignment' AND action IN ('assignment.added', 'assignment.removed') AND record_id IS NOT NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'team-archive' AND action IN ('team.archived', 'team.restored')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'user-account' AND action IN ('user.deactivated', 'user.reactivated', 'user.signed_out_everywhere', 'user.lockout_cleared')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'salary-brackets' AND action = 'salary_brackets.published'
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'group' AND action IN ('group.created', 'group.renamed', 'group.archived', 'group.approval_set',
        'group.approval_cleared', 'group.member_added', 'group.member_removed', 'group.child_added', 'group.child_removed',
        'group.child_replaced', 'group.manager_added', 'group.manager_removed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    -- A missing or malformed workspaceId fails the insert; the CASE keeps the cast from raising.
    OR (kind = 'domain' AND action IN ('domain.url_recorded', 'domain.url_changed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND CASE WHEN metadata->>'workspaceId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN tenant_context.allows_workspace((metadata->>'workspaceId')::uuid, 'write', 'domain')
        ELSE false END)))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND employee_erasure_id IS NULL AND user_anonymisation_id IS NULL
    AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'employee-erasure' AND action = 'employee.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NOT NULL AND user_anonymisation_id IS NULL
    AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'user-anonymisation' AND action = 'user.anonymised' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NULL AND user_anonymisation_id IS NOT NULL
    AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The code now reads and writes through the manager policies and replaces child groups; startup
-- refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 33;
