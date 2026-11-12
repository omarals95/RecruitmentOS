-- Company groups: tables, nesting and effective membership (ADM-11, job 092). Apply after
-- 0051_user_anonymisation.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which
-- grants the data role SELECT, INSERT, UPDATE and DELETE on app.groups, app.group_members and
-- app.group_managers, SELECT only on app.group_effective_members, and EXECUTE on
-- tenant_context.group_grants and tenant_context.computed_group_members; the identity role gets
-- nothing. Groups are company rows keyed by workspace that hold people and other groups, never
-- records (D1). app.guard_group_write() lets only company owners and company admins with the people
-- area change them, and only a company owner change a group that is, or is nested in, an approval
-- group (tenant_context.group_grants, D20). app.maintain_group_members() refuses a cycle or nesting
-- deeper than 3 levels (D19) and rebuilds app.group_effective_members, which no runtime role writes.
-- app.audit_group_change() writes one ids-only activity row per change. computed_group_members
-- answers the computed groups (company owners, company admins, all members, and each team's owners
-- and admins) from the authority and member rows, read-only and never stored. allows_workspace gains
-- the people area, and the app.activity insert policy and tenant_context.anonymise_user get new
-- bodies: anonymisation also removes the person's group member and manager rows. No existing row is
-- rewritten. The storage schema marker goes to 30, so startup refuses a database without this
-- migration.

-- Names are unique, case-insensitive, among a workspace's current groups (IAM-040).
CREATE TABLE app.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500),
  approval boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX groups_current_name ON app.groups(workspace_id, lower(name)) WHERE archived_at IS NULL;
-- One direct member per row: a user or a child group of the same workspace.
CREATE TABLE app.group_members (
  group_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id text REFERENCES auth."user"(id) ON DELETE CASCADE,
  child_group_id uuid,
  added_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_members_one_member CHECK (num_nonnulls(user_id, child_group_id) = 1),
  CONSTRAINT group_members_not_self CHECK (child_group_id IS DISTINCT FROM group_id),
  CONSTRAINT group_members_group_fkey FOREIGN KEY (group_id, workspace_id) REFERENCES app.groups(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT group_members_child_fkey FOREIGN KEY (child_group_id, workspace_id) REFERENCES app.groups(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX group_members_user ON app.group_members(group_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX group_members_child ON app.group_members(group_id, child_group_id) WHERE child_group_id IS NOT NULL;
CREATE INDEX group_members_child_idx ON app.group_members(child_group_id);
CREATE INDEX group_members_user_idx ON app.group_members(user_id);
-- Delegated managers (ADM-13); no behaviour yet.
CREATE TABLE app.group_managers (
  group_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT group_managers_group_fkey FOREIGN KEY (group_id, workspace_id) REFERENCES app.groups(id, workspace_id) ON DELETE CASCADE
);
-- A row exists exactly when the user is a direct user member of the group or of a group nested below
-- it at any depth. Written by app.maintain_group_members() alone.
CREATE TABLE app.group_effective_members (
  workspace_id uuid NOT NULL,
  group_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id, workspace_id) REFERENCES app.groups(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX group_effective_members_user_idx ON app.group_effective_members(user_id);

-- As in 0044, plus the people area: it reads only for a session whose company level is owner, or
-- admin holding people, and writes as the other areas do. Every other area answers as before.
-- CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.allows_workspace(row_workspace uuid, access text, area text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace
      AND area IN ('fields','workflows','boards','organisation','templates','roles','task-board','people')
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

-- True when the group, or any group it is nested in at any depth, archived or not, is an approval
-- group. Only groups of the current context's workspace count: an unknown group, a group of another
-- workspace or no context is false. Reveals that boolean only.
CREATE FUNCTION tenant_context.group_grants(group_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE ctx AS (
    SELECT c.workspace_id FROM tenant_context.contexts c
      WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
        AND c.expires_at > clock_timestamp() AND c.workspace_id IS NOT NULL
  ), up(id) AS (
    SELECT g.id FROM app.groups g JOIN ctx ON g.workspace_id = ctx.workspace_id WHERE g.id = group_grants.group_id
    UNION
    SELECT m.group_id FROM up JOIN app.group_members m ON m.child_group_id = up.id
      JOIN ctx ON m.workspace_id = ctx.workspace_id
  )
  SELECT EXISTS (SELECT 1 FROM up JOIN app.groups g ON g.id = up.id WHERE g.approval)
$$;
REVOKE ALL ON FUNCTION tenant_context.group_grants(uuid) FROM PUBLIC;

-- A session context of a company owner, or of a company admin holding people (42501 otherwise),
-- reads the computed groups of its workspace: company-owners and company-admins from unsuspended
-- app.workspace_admins rows, all-members from auth.member rows in any team of the workspace, and
-- team-owners:<team id> and team-admins:<team id> from the member rows of that team. An unknown key,
-- or a team that is not the workspace's, is 22023. Distinct user ids only, ordered; never stored,
-- never a member of app.groups and never an approval group.
CREATE FUNCTION tenant_context.computed_group_members(group_key text) RETURNS TABLE(user_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  team text := substr(group_key, strpos(group_key, ':') + 1);
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL OR ctx.company_level IS NULL
     OR NOT (ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas))) THEN
    RAISE EXCEPTION 'Computed group rejected' USING ERRCODE = '42501';
  END IF;
  IF group_key IN ('company-owners', 'company-admins') THEN
    RETURN QUERY SELECT DISTINCT a.user_id FROM app.workspace_admins a
      WHERE a.workspace_id = ctx.workspace_id AND a.suspended_at IS NULL
        AND a.level = CASE group_key WHEN 'company-owners' THEN 'owner' ELSE 'admin' END
      ORDER BY a.user_id;
  ELSIF group_key = 'all-members' THEN
    RETURN QUERY SELECT DISTINCT m.user_id FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
      WHERE t.workspace_id = ctx.workspace_id ORDER BY m.user_id;
  ELSIF split_part(group_key, ':', 1) IN ('team-owners', 'team-admins')
     AND EXISTS (SELECT 1 FROM app.workspace_teams t WHERE t.team_id = team AND t.workspace_id = ctx.workspace_id) THEN
    RETURN QUERY SELECT DISTINCT m.user_id FROM auth.member m
      WHERE m.organization_id = team
        AND m.role = CASE split_part(group_key, ':', 1) WHEN 'team-owners' THEN 'owner' ELSE 'admin' END
      ORDER BY m.user_id;
  ELSE
    RAISE EXCEPTION 'Unknown computed group' USING ERRCODE = '22023';
  END IF;
END $$;
REVOKE ALL ON FUNCTION tenant_context.computed_group_members(text) FROM PUBLIC;

-- Company owners and company admins with people read and write groups, members and managers
-- (allows_workspace); a group that grants something is changed only under a company owner context
-- (the roles area). An update or delete may target any readable row, so a refused one reaches the
-- guard below and fails with 42501 instead of matching no row. No runtime role deletes a group,
-- and none writes the effective membership.
DO $group_rls$ DECLARE tbl text; command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  read_rule text := 'tenant_context.allows_workspace(workspace_id, ''read'', ''people'')';
  write_rule text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['groups','group_members','group_managers','group_effective_members'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', tbl);
  -- Owner-only access for the migration, the trigger functions, owner-run helpers and fixtures.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'group_owner_' || lower(command), tbl, command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (%s)', tbl, read_rule);
  IF tbl <> 'group_effective_members' THEN
   write_rule := 'tenant_context.allows_workspace(workspace_id, ''write'', ''people'') AND (tenant_context.allows_workspace(workspace_id, ''write'', ''roles'') OR '
     || CASE tbl WHEN 'groups' THEN '(NOT approval AND NOT tenant_context.group_grants(id)))'
          ELSE 'NOT tenant_context.group_grants(group_id))' END;
   EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', tbl, write_rule);
   EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, read_rule, write_rule);
  END IF;
  IF tbl IN ('group_members', 'group_managers') THEN
   EXECUTE format('CREATE POLICY context_delete ON app.%I FOR DELETE USING (%s)', tbl, read_rule);
  END IF;
 END LOOP;
END $group_rls$;

-- Every group, member and manager write. A security definer function, because only the owner reads
-- the context table, so current_user is the owner here: the owner's own SQL (the migration,
-- fixtures) is told apart as in app.guard_scope_sources, by having no context row, and no runtime
-- role writes these tables without one (every runtime policy needs it). An owner-run helper called
-- under a context, such as anonymise_user, needs a company owner context and passes the checks
-- below. Any other write needs an unexpired session context of the row's workspace whose company
-- level is owner, or admin holding people (42501 otherwise: tokens, team-only owners and admins,
-- admins without people, other workspaces). The workspace row lock then serialises grant checks,
-- nesting changes and rebuilds per workspace. Below company owner, a change to a group for which
-- group_grants is true (the group itself, or a member, child or manager row of it, OLD and NEW), an
-- approval group insert and any change of the flag are 42501. Row rules for context writes: a
-- group's id, workspace, creator and creation time never change, an insert is never archived, and
-- member and manager rows are inserted and deleted, never updated (42501). An archived group stays
-- archived, for the owner too. A user member or manager must be in a team of the workspace (RQ006).
-- added_by and added_at come from the context.
CREATE FUNCTION app.guard_group_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'groups' THEN
    IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND (OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL) THEN
      RAISE EXCEPTION 'An archived group stays archived' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
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
  IF ctx.auth_type IS DISTINCT FROM 'session' OR ctx.workspace_id IS DISTINCT FROM row_workspace
     OR (TG_OP = 'UPDATE' AND OLD.workspace_id IS DISTINCT FROM row_workspace)
     OR NOT coalesce(ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas)), false) THEN
    RAISE EXCEPTION 'Changing groups needs a company owner, or a company admin with the people area' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = row_workspace FOR NO KEY UPDATE;
  IF ctx.company_level <> 'owner' THEN
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
    ELSIF (NEW.id, NEW.workspace_id, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'Group row rejected' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Group members and managers are added and removed, never changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
       WHERE m.user_id = NEW.user_id AND t.workspace_id = row_workspace) THEN
    RAISE EXCEPTION 'The member is in no team of this company' USING ERRCODE = 'RQ006';
  END IF;
  IF TG_TABLE_NAME = 'group_members' THEN
    NEW.added_by := ctx.actor_id;
    NEW.added_at := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_group_write() FROM PUBLIC;
CREATE TRIGGER groups_guard BEFORE INSERT OR UPDATE OR DELETE ON app.groups
  FOR EACH ROW EXECUTE FUNCTION app.guard_group_write();
CREATE TRIGGER group_members_guard BEFORE INSERT OR UPDATE OR DELETE ON app.group_members
  FOR EACH ROW EXECUTE FUNCTION app.guard_group_write();
CREATE TRIGGER group_managers_guard BEFORE INSERT OR UPDATE OR DELETE ON app.group_managers
  FOR EACH ROW EXECUTE FUNCTION app.guard_group_write();
-- created_by comes from the verified context, as for configuration (0030).
CREATE TRIGGER groups_stamp BEFORE INSERT ON app.groups
  FOR EACH ROW EXECUTE FUNCTION app.stamp_config_actor();

-- Nesting and effective membership, under the workspace row lock. A child link that makes the
-- child the group itself or one of its ancestors is RQ021; one whose longest chain of groups (the
-- longest ancestor chain above the parent, the parent, the child and the longest descendant chain
-- below it) exceeds 3 is RQ022 (D19). Then the effective rows of the row's group, OLD and NEW, and
-- of every group it is nested in are deleted and rebuilt from the direct user members of each and
-- of its descendants; other groups' rows are untouched. A security definer function, so no runtime
-- role needs a write grant on app.group_effective_members.
CREATE FUNCTION app.maintain_group_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  starts uuid[] := '{}';
  affected uuid[];
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
    starts := array_append(starts, NEW.group_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM 1 FROM app.workspaces w WHERE w.id = OLD.workspace_id FOR NO KEY UPDATE;
    starts := array_append(starts, OLD.group_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.child_group_id IS NOT NULL THEN
    IF NEW.child_group_id = NEW.group_id OR EXISTS (
        WITH RECURSIVE up(id) AS (
          SELECT NEW.group_id
          UNION
          SELECT m.group_id FROM up JOIN app.group_members m ON m.child_group_id = up.id)
        SELECT 1 FROM up WHERE up.id = NEW.child_group_id) THEN
      RAISE EXCEPTION 'A group cannot contain itself or a group that contains it' USING ERRCODE = 'RQ021';
    END IF;
    -- Each walk stops at 3 links: one that long already makes the chain too deep.
    IF (WITH RECURSIVE up(id, links) AS (
          SELECT NEW.group_id, 0
          UNION ALL
          SELECT m.group_id, up.links + 1 FROM up JOIN app.group_members m ON m.child_group_id = up.id WHERE up.links < 3),
        down(id, links) AS (
          SELECT NEW.child_group_id, 0
          UNION ALL
          SELECT m.child_group_id, down.links + 1 FROM down JOIN app.group_members m
            ON m.group_id = down.id AND m.child_group_id IS NOT NULL WHERE down.links < 3)
        SELECT (SELECT max(up.links) FROM up) + (SELECT max(down.links) FROM down) + 2) > 3 THEN
      RAISE EXCEPTION 'Groups nest at most 3 levels' USING ERRCODE = 'RQ022';
    END IF;
  END IF;
  WITH RECURSIVE up(id) AS (
    SELECT s.id FROM unnest(starts) s(id)
    UNION
    SELECT m.group_id FROM up JOIN app.group_members m ON m.child_group_id = up.id)
  SELECT array_agg(up.id) INTO affected FROM up;
  DELETE FROM app.group_effective_members e WHERE e.group_id = ANY(affected);
  WITH RECURSIVE tree(root, id) AS (
    SELECT a.id, a.id FROM unnest(affected) a(id)
    UNION
    SELECT tree.root, m.child_group_id FROM tree JOIN app.group_members m
      ON m.group_id = tree.id AND m.child_group_id IS NOT NULL)
  INSERT INTO app.group_effective_members(workspace_id, group_id, user_id)
    SELECT DISTINCT g.workspace_id, tree.root, m.user_id FROM tree
      JOIN app.group_members m ON m.group_id = tree.id AND m.user_id IS NOT NULL
      JOIN app.groups g ON g.id = tree.root;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.maintain_group_members() FROM PUBLIC;
CREATE TRIGGER group_members_maintain AFTER INSERT OR UPDATE OR DELETE ON app.group_members
  FOR EACH ROW EXECUTE FUNCTION app.maintain_group_members();

-- One group activity row per change by a context of the row's workspace, written to the acting
-- team; an update that changes several things writes one row per action, as app.audit_org_change.
-- Metadata holds ids only, never a name, description or email: the workspace and group, plus
-- targetUserId for a user member or manager (so user anonymisation redacts it) or childGroupId for
-- a child group. The owner's own SQL has no context row and writes nothing.
CREATE FUNCTION app.audit_group_change() RETURNS trigger
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
      AND c.expires_at > clock_timestamp() AND c.workspace_id = (changed_row->>'workspace_id')::uuid;
  IF NOT FOUND THEN
    RETURN NULL;
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
        WHEN 'group.manager_added' THEN 'Added a group manager'
        ELSE 'Removed a group manager' END,
      metadata);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.audit_group_change() FROM PUBLIC;
CREATE TRIGGER groups_audit AFTER INSERT OR UPDATE OR DELETE ON app.groups
  FOR EACH ROW EXECUTE FUNCTION app.audit_group_change();
CREATE TRIGGER group_members_audit AFTER INSERT OR UPDATE OR DELETE ON app.group_members
  FOR EACH ROW EXECUTE FUNCTION app.audit_group_change();
CREATE TRIGGER group_managers_audit AFTER INSERT OR UPDATE OR DELETE ON app.group_managers
  FOR EACH ROW EXECUTE FUNCTION app.audit_group_change();

-- As in 0051, plus: group rows come only from the owner (app.audit_group_change above); no runtime
-- role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND user_anonymisation_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment', 'team-archive', 'user-account', 'salary-brackets', 'user-anonymisation', 'group') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
        'group.manager_added', 'group.manager_removed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
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

-- As in 0051, plus the person's group member and manager rows in the context's workspace, deleted
-- before the redaction so the group.member_removed and group.manager_removed rows they write are
-- redacted with the rest; app.maintain_group_members removes their effective rows. The returned
-- counts, refusals and order of checks are unchanged. CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.anonymise_user(user_id text, confirm_name text, erasure_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  subject auth."user"%ROWTYPE;
  earlier app.user_anonymisations%ROWTYPE;
  earlier_counts jsonb;
  tombstone uuid := gen_random_uuid();
  anonymised_time timestamptz;
  memberships integer;
  sessions integer;
  tokens integer;
  two_step integer;
  configured_roles integer;
  assignments integer;
  authority integer;
  invitations integer;
  redacted integer;
  removed jsonb;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS DISTINCT FROM 'owner' OR ctx.workspace_id IS NULL
     OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'User anonymisation rejected' USING ERRCODE = '42501';
  END IF;
  IF anonymise_user.user_id IS NULL OR anonymise_user.user_id = '' OR length(anonymise_user.user_id) > 128
     OR anonymise_user.erasure_source IS NULL OR anonymise_user.erasure_source NOT IN ('app', 'script') THEN
    RAISE EXCEPTION 'User anonymisation rejected' USING ERRCODE = '22023';
  END IF;
  -- One account change at a time per workspace, as account_change_context; the caller may have lost
  -- authority, or been deactivated, while waiting.
  PERFORM 1 FROM app.workspaces w WHERE w.id = ctx.workspace_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = ctx.workspace_id
       AND a.user_id = ctx.actor_id AND a.level = 'owner' AND a.suspended_at IS NULL)
     OR EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = ctx.workspace_id
       AND d.user_id = ctx.actor_id AND d.deactivated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'User anonymisation rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO subject FROM auth."user" u WHERE u.id = anonymise_user.user_id FOR UPDATE;
  SELECT * INTO earlier FROM app.user_anonymisations x
    WHERE x.workspace_id = ctx.workspace_id AND x.user_id = anonymise_user.user_id;
  IF FOUND THEN
    SELECT a.metadata INTO earlier_counts FROM app.activity a
      WHERE a.user_anonymisation_id = earlier.id AND a.kind = 'user-anonymisation' AND a.action = 'user.anonymised';
    RETURN jsonb_build_object('anonymisationId', earlier.id, 'alreadyAnonymised', true,
      'anonymisedAt', earlier.anonymised_at,
      'removed', jsonb_build_object('memberships', earlier_counts->'memberships',
        'sessions', earlier_counts->'sessions', 'apiTokens', earlier_counts->'apiTokens',
        'twoStep', earlier_counts->'twoStep', 'configuredRoles', earlier_counts->'configuredRoles',
        'recordAssignments', earlier_counts->'recordAssignments',
        'companyAuthority', earlier_counts->'companyAuthority', 'invitations', earlier_counts->'invitations',
        'activityRedacted', earlier_counts->'activityRedacted'));
  END IF;
  IF subject.id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
       WHERE m.user_id = subject.id AND t.workspace_id = ctx.workspace_id) THEN
    RETURN NULL;
  END IF;
  IF btrim(coalesce(anonymise_user.confirm_name, '')) = '' OR btrim(anonymise_user.confirm_name) <> btrim(subject.name) THEN
    RAISE EXCEPTION 'User anonymisation confirmation mismatch' USING ERRCODE = 'RQ003';
  END IF;
  -- The account is shared with another company, which this one may not change (D1).
  IF EXISTS (SELECT 1 FROM auth.member m LEFT JOIN app.workspace_teams t ON t.team_id = m.organization_id
       WHERE m.user_id = subject.id AND t.workspace_id IS DISTINCT FROM ctx.workspace_id) THEN
    RAISE EXCEPTION 'The person is also in a team of another company' USING ERRCODE = 'RQ020';
  END IF;
  -- As auth.protect_last_owner counts: owner member rows, archived teams included.
  IF EXISTS (SELECT 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
       WHERE m.user_id = subject.id AND t.workspace_id = ctx.workspace_id AND m.role = 'owner'
         AND NOT EXISTS (SELECT 1 FROM auth.member o WHERE o.organization_id = m.organization_id
           AND o.role = 'owner' AND o.user_id <> subject.id)) THEN
    RAISE EXCEPTION 'The last owner of a team cannot be anonymised' USING ERRCODE = 'RQ019';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = ctx.workspace_id
       AND a.user_id = subject.id AND a.level = 'owner' AND a.suspended_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = ctx.workspace_id
       AND a.user_id <> subject.id AND a.level = 'owner' AND a.suspended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = a.workspace_id
         AND d.user_id = a.user_id AND d.deactivated_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'The last company owner cannot be anonymised' USING ERRCODE = 'RQ005';
  END IF;
  IF subject.id = ctx.actor_id THEN
    RAISE EXCEPTION 'You cannot change your own account' USING ERRCODE = 'RQ018';
  END IF;

  anonymised_time := clock_timestamp();
  INSERT INTO app.user_anonymisations(id, workspace_id, user_id, anonymised_by, anonymised_at, erasure_source)
    VALUES (tombstone, ctx.workspace_id, subject.id, ctx.actor_id, anonymised_time, anonymise_user.erasure_source);
  -- In the context's team, app.audit_member_role writes one role.cleared row, redacted below.
  DELETE FROM app.member_roles r WHERE r.user_id = subject.id
    AND r.team_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id);
  GET DIAGNOSTICS configured_roles = ROW_COUNT;
  DELETE FROM app.record_assignments ra WHERE ra.user_id = subject.id
    AND ra.team_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id);
  GET DIAGNOSTICS assignments = ROW_COUNT;
  -- app.audit_group_change writes one group.member_removed or group.manager_removed row per row,
  -- redacted below; app.maintain_group_members removes the effective rows.
  DELETE FROM app.group_members gm WHERE gm.user_id = subject.id AND gm.workspace_id = ctx.workspace_id;
  DELETE FROM app.group_managers gr WHERE gr.user_id = subject.id AND gr.workspace_id = ctx.workspace_id;
  DELETE FROM app.workspace_admins a WHERE a.workspace_id = ctx.workspace_id AND a.user_id = subject.id;
  GET DIAGNOSTICS authority = ROW_COUNT;
  -- Personal tokens and MCP OAuth grants; their OAuth codes and tokens cascade.
  DELETE FROM auth.api_tokens k WHERE k.user_id = subject.id;
  GET DIAGNOSTICS tokens = ROW_COUNT;
  DELETE FROM auth.session s WHERE s.user_id = subject.id;
  GET DIAGNOSTICS sessions = ROW_COUNT;
  DELETE FROM auth.account ac WHERE ac.user_id = subject.id;
  DELETE FROM auth.two_factor f WHERE f.user_id = subject.id;
  GET DIAGNOSTICS two_step = ROW_COUNT;
  -- Trusted devices, two-step challenges and password resets name the user id; anything keyed by
  -- the address names the email.
  DELETE FROM auth.verification v WHERE v.value = subject.id OR lower(v.identifier) = lower(subject.email);
  DELETE FROM auth.invitation i WHERE lower(i.email) = lower(subject.email)
    AND i.organization_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id);
  GET DIAGNOSTICS invitations = ROW_COUNT;
  -- Last: no company authority row is left for app.suspend_workspace_authority to suspend.
  DELETE FROM auth.member m WHERE m.user_id = subject.id
    AND m.organization_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id);
  GET DIAGNOSTICS memberships = ROW_COUNT;
  UPDATE auth."user" u SET name = 'Former user ' || left(replace(tombstone::text, '-', ''), 8),
    email = 'anonymised-' || tombstone::text || '@invalid', email_verified = false, two_factor_enabled = false,
    image = NULL, updated_at = now()
    WHERE u.id = subject.id;
  -- The rows about the person, in every team of the workspace, including the role.cleared row above.
  UPDATE app.activity a SET user_anonymisation_id = tombstone, summary = 'Details removed by user anonymisation',
    metadata = '{}'
    WHERE a.team_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id)
      AND a.user_anonymisation_id IS NULL
      AND (a.metadata->>'targetUserId' = subject.id OR a.metadata->>'affectedUserId' = subject.id
        OR (a.kind = 'assignment' AND a.metadata->>'userId' = subject.id)
        OR a.metadata->'affectedUserIds' @> jsonb_build_array(subject.id));
  GET DIAGNOSTICS redacted = ROW_COUNT;
  removed := jsonb_build_object('memberships', memberships, 'sessions', sessions, 'apiTokens', tokens,
    'twoStep', two_step, 'configuredRoles', configured_roles, 'recordAssignments', assignments,
    'companyAuthority', authority, 'invitations', invitations, 'activityRedacted', redacted);
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata,
    user_anonymisation_id, created_at)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'user.anonymised', 'user-anonymisation',
    'Anonymised a user account',
    jsonb_build_object('source', anonymise_user.erasure_source, 'workspaceId', ctx.workspace_id) || removed,
    tombstone, anonymised_time);
  RETURN jsonb_build_object('anonymisationId', tombstone, 'alreadyAnonymised', false,
    'anonymisedAt', anonymised_time, 'removed', removed);
END $$;

-- The code now depends on the group tables, triggers and helpers; startup refuses a database
-- without them.
UPDATE db_boundary.storage_schema SET version = 30;
