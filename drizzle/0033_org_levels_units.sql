-- Organisation levels, effective-dated units and their closure (R2a-13, job 047). Apply after
-- 0032_config_versions_install.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which
-- grants the data role SELECT, INSERT and UPDATE on app.org_levels and app.org_units and SELECT only
-- on app.org_unit_closure: closure rows are written by app.maintain_org_closure() alone. No helper
-- gains EXECUTE; every new function is an owner-owned trigger function. The storage schema marker
-- goes to 12, so startup refuses a database without this migration. tenant_context.install, the team
-- tables and their policies are unchanged.

-- Company rows keyed by workspace (D1): at most 8 levels, top is depth 0. A unit's level is deeper
-- than its parent's; its code is unique among the workspace's current rows.
CREATE TABLE app.org_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  depth integer NOT NULL CHECK (depth BETWEEN 0 AND 7),
  archived_at timestamptz,
  CONSTRAINT org_levels_depth_unique UNIQUE (workspace_id, depth),
  UNIQUE (id, workspace_id)
);
CREATE TABLE app.org_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  parent_id uuid,
  level_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 120),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  archived_at timestamptz,
  CONSTRAINT org_units_valid_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (id, workspace_id),
  CONSTRAINT org_units_level_fkey FOREIGN KEY (level_id, workspace_id) REFERENCES app.org_levels(id, workspace_id),
  CONSTRAINT org_units_parent_fkey FOREIGN KEY (parent_id, workspace_id) REFERENCES app.org_units(id, workspace_id)
);
CREATE UNIQUE INDEX org_units_current_code ON app.org_units(workspace_id, code)
  WHERE valid_to IS NULL AND archived_at IS NULL;
CREATE INDEX org_units_parent_idx ON app.org_units(workspace_id, parent_id);
-- Every unit is its own ancestor at depth 0; depth is the distance from ancestor to descendant.
CREATE TABLE app.org_unit_closure (
  workspace_id uuid NOT NULL,
  ancestor_id uuid NOT NULL,
  descendant_id uuid NOT NULL,
  depth integer NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_id, descendant_id),
  FOREIGN KEY (ancestor_id, workspace_id) REFERENCES app.org_units(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (descendant_id, workspace_id) REFERENCES app.org_units(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX org_unit_closure_descendant_idx ON app.org_unit_closure(descendant_id);

-- Any context of the row's workspace reads; a session with the organisation area or a company owner
-- writes (allows_workspace, 0030). An update may target any readable row, so a reader's update
-- reaches the guards below and fails with 42501 instead of matching no row. No runtime role deletes,
-- and none writes the closure table.
DO $org_rls$ DECLARE tbl text; command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  read_rule text := 'tenant_context.allows_workspace(workspace_id, ''read'', ''organisation'')';
  write_rule text := 'tenant_context.allows_workspace(workspace_id, ''write'', ''organisation'')';
BEGIN
 FOREACH tbl IN ARRAY ARRAY['org_levels','org_units','org_unit_closure'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', tbl);
  -- Owner-only access for the migration, the trigger functions and the owner's fixture cleanup.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'org_owner_' || lower(command), tbl, command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (%s)', tbl, read_rule);
  IF tbl <> 'org_unit_closure' THEN
   EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', tbl, write_rule);
   EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, read_rule, write_rule);
  END IF;
 END LOOP;
END $org_rls$;

-- Row rules for a runtime role. A security invoker function, like app.guard_config_object, so
-- current_user is the caller. After insert only a unit's name, parent and archive time and a level's
-- name and archive time change; a runtime insert is never archived or closed. Archiving is one-way.
CREATE FUNCTION app.guard_org_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner boolean := current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.archived_at IS DISTINCT FROM OLD.archived_at
     AND (OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL) THEN
    RAISE EXCEPTION 'An archived organisation level or unit stays archived' USING ERRCODE = '42501';
  END IF;
  IF owner THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Organisation row rejected' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'org_units' THEN
      IF NEW.valid_to IS NOT NULL THEN
        RAISE EXCEPTION 'Organisation row rejected' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'org_levels' THEN
    IF (NEW.id, NEW.workspace_id, NEW.depth) IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.depth) THEN
      RAISE EXCEPTION 'Organisation row rejected' USING ERRCODE = '42501';
    END IF;
  ELSIF (NEW.id, NEW.workspace_id, NEW.level_id, NEW.code, NEW.created_by, NEW.valid_from, NEW.valid_to)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.level_id, OLD.code, OLD.created_by, OLD.valid_from, OLD.valid_to) THEN
    RAISE EXCEPTION 'Organisation row rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_org_row() FROM PUBLIC;
CREATE TRIGGER org_levels_guard BEFORE INSERT OR UPDATE ON app.org_levels
  FOR EACH ROW EXECUTE FUNCTION app.guard_org_row();
CREATE TRIGGER org_units_guard BEFORE INSERT OR UPDATE ON app.org_units
  FOR EACH ROW EXECUTE FUNCTION app.guard_org_row();
-- created_by comes from the verified context, as for configuration (0030).
CREATE TRIGGER org_units_stamp BEFORE INSERT ON app.org_units
  FOR EACH ROW EXECUTE FUNCTION app.stamp_config_actor();

-- Home units grant record scope, so moving or archiving a unit is role assignment (architecture
-- 6.5): a parent change, an archive, and an insert giving a code a new effective parent (the most
-- recent row with that code, by valid_from) need a session context whose company level is owner in
-- the row's workspace, never a token context. A security definer function, because only the owner
-- reads the context table; the owner's own SQL has no context row and is let through. A runtime
-- role cannot write without a context.
CREATE FUNCTION app.guard_scope_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND OR (ctx.auth_type = 'session' AND ctx.company_level = 'owner' AND ctx.workspace_id = NEW.workspace_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'Only a company owner can move or archive an organisation unit' USING ERRCODE = '42501';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM (SELECT u.parent_id FROM app.org_units u
        WHERE u.workspace_id = NEW.workspace_id AND u.code = NEW.code
        ORDER BY u.valid_from DESC, u.id DESC LIMIT 1) latest
      WHERE latest.parent_id IS DISTINCT FROM NEW.parent_id) THEN
    RAISE EXCEPTION 'Only a company owner can give an organisation unit a new parent' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_scope_sources() FROM PUBLIC;
CREATE TRIGGER org_units_scope BEFORE INSERT OR UPDATE ON app.org_units
  FOR EACH ROW EXECUTE FUNCTION app.guard_scope_sources();

-- The closure rows of an inserted or moved unit, and its level and parent rules: RQ009 for a parent
-- that is the unit or below it (checked first, since such a parent also breaks the level order),
-- RQ008 for a parent whose level is not above the unit's, RQ010 for a parent that is archived or
-- closed, or an insert on an archived level. One insert or move at a time per workspace: the
-- workspace row lock is taken before any ancestry is read and held to the end of the transaction,
-- so concurrent moves cannot make a cycle and an insert cannot copy stale ancestry. A security
-- definer function, so no runtime role needs a write grant on the closure table.
CREATE FUNCTION app.maintain_org_closure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  own_level app.org_levels%ROWTYPE;
  parent_depth integer;
  parent_current boolean;
BEGIN
  PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR UPDATE;
  IF NEW.parent_id IS NOT NULL AND (NEW.parent_id = NEW.id OR EXISTS (SELECT 1 FROM app.org_unit_closure c
       WHERE c.workspace_id = NEW.workspace_id AND c.ancestor_id = NEW.id AND c.descendant_id = NEW.parent_id)) THEN
    RAISE EXCEPTION 'A unit cannot be moved under itself or a unit below it' USING ERRCODE = 'RQ009';
  END IF;
  SELECT * INTO own_level FROM app.org_levels l WHERE l.id = NEW.level_id AND l.workspace_id = NEW.workspace_id;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT l.depth, u.archived_at IS NULL AND u.valid_to IS NULL INTO parent_depth, parent_current
      FROM app.org_units u JOIN app.org_levels l ON l.id = u.level_id AND l.workspace_id = u.workspace_id
      WHERE u.id = NEW.parent_id AND u.workspace_id = NEW.workspace_id;
    IF parent_depth >= own_level.depth THEN
      RAISE EXCEPTION 'A unit''s level must be below its parent''s level' USING ERRCODE = 'RQ008';
    END IF;
    IF NOT parent_current THEN
      RAISE EXCEPTION 'The parent unit is archived' USING ERRCODE = 'RQ010';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF own_level.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'The level is archived' USING ERRCODE = 'RQ010';
    END IF;
    INSERT INTO app.org_unit_closure(workspace_id, ancestor_id, descendant_id, depth)
      SELECT NEW.workspace_id, NEW.id, NEW.id, 0
      UNION ALL
      SELECT NEW.workspace_id, c.ancestor_id, NEW.id, c.depth + 1 FROM app.org_unit_closure c
        WHERE c.workspace_id = NEW.workspace_id AND c.descendant_id = NEW.parent_id;
  ELSE
    -- Unlink the moved subtree from its old ancestors, then link it below every new ancestor.
    DELETE FROM app.org_unit_closure d
      WHERE d.workspace_id = NEW.workspace_id
        AND d.descendant_id IN (SELECT s.descendant_id FROM app.org_unit_closure s
          WHERE s.workspace_id = NEW.workspace_id AND s.ancestor_id = NEW.id)
        AND d.ancestor_id NOT IN (SELECT s.descendant_id FROM app.org_unit_closure s
          WHERE s.workspace_id = NEW.workspace_id AND s.ancestor_id = NEW.id);
    INSERT INTO app.org_unit_closure(workspace_id, ancestor_id, descendant_id, depth)
      SELECT NEW.workspace_id, a.ancestor_id, s.descendant_id, a.depth + s.depth + 1
        FROM app.org_unit_closure a JOIN app.org_unit_closure s
          ON s.workspace_id = NEW.workspace_id AND s.ancestor_id = NEW.id
        WHERE a.workspace_id = NEW.workspace_id AND a.descendant_id = NEW.parent_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.maintain_org_closure() FROM PUBLIC;
CREATE TRIGGER org_units_closure_insert AFTER INSERT ON app.org_units
  FOR EACH ROW EXECUTE FUNCTION app.maintain_org_closure();
CREATE TRIGGER org_units_closure_move AFTER UPDATE OF parent_id ON app.org_units
  FOR EACH ROW WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id) EXECUTE FUNCTION app.maintain_org_closure();

-- RQ010 for archiving a unit with a current child or a level with a current unit; under the same
-- workspace lock, so an insert or move under the unit cannot slip past it.
CREATE FUNCTION app.guard_org_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.org_units u
      WHERE u.workspace_id = NEW.workspace_id AND u.archived_at IS NULL AND u.valid_to IS NULL
        AND CASE TG_TABLE_NAME WHEN 'org_units' THEN u.parent_id = NEW.id ELSE u.level_id = NEW.id END) THEN
    RAISE EXCEPTION 'Archive or move the units below it first' USING ERRCODE = 'RQ010';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.guard_org_archive() FROM PUBLIC;
CREATE TRIGGER org_levels_archive AFTER UPDATE OF archived_at ON app.org_levels
  FOR EACH ROW WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at) EXECUTE FUNCTION app.guard_org_archive();
CREATE TRIGGER org_units_archive AFTER UPDATE OF archived_at ON app.org_units
  FOR EACH ROW WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at) EXECUTE FUNCTION app.guard_org_archive();

-- One org activity row per create, rename, move and archive by a context of the row's workspace,
-- written to the acting team; a move or archive of a unit, or an insert giving a code a new effective
-- parent, also writes one scope.home_units_changed row. Metadata holds ids only, never a name or
-- code. No employees exist before R2a-14, so affectedUserIds is empty. A security definer function,
-- so direct-SQL writes are audited too; the owner's own SQL has no context row and writes nothing.
CREATE FUNCTION app.audit_org_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  actions text[] := '{}';
  action text;
  from_parent uuid;
  metadata jsonb;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'org_levels' THEN
    IF TG_OP = 'INSERT' THEN
      actions := ARRAY['org.level_created'];
    ELSE
      IF NEW.name IS DISTINCT FROM OLD.name THEN
        actions := array_append(actions, 'org.level_renamed');
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := array_append(actions, 'org.level_archived');
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      actions := ARRAY['org.unit_created'];
      IF EXISTS (SELECT 1 FROM (SELECT u.parent_id FROM app.org_units u
            WHERE u.workspace_id = NEW.workspace_id AND u.code = NEW.code AND u.id <> NEW.id
            ORDER BY u.valid_from DESC, u.id DESC LIMIT 1) latest
          WHERE latest.parent_id IS DISTINCT FROM NEW.parent_id) THEN
        actions := array_append(actions, 'scope.home_units_changed');
      END IF;
    ELSE
      from_parent := OLD.parent_id;
      IF NEW.name IS DISTINCT FROM OLD.name THEN
        actions := array_append(actions, 'org.unit_renamed');
      END IF;
      IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
        actions := actions || ARRAY['org.unit_moved', 'scope.home_units_changed'];
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := actions || ARRAY['org.unit_archived', 'scope.home_units_changed'];
      END IF;
    END IF;
  END IF;
  FOREACH action IN ARRAY actions LOOP
    IF TG_TABLE_NAME = 'org_levels' THEN
      metadata := jsonb_build_object('workspaceId', NEW.workspace_id, 'levelId', NEW.id, 'depth', NEW.depth);
    ELSIF action = 'scope.home_units_changed' THEN
      metadata := jsonb_build_object('workspaceId', NEW.workspace_id, 'unitId', NEW.id, 'affectedUserIds', '[]'::jsonb);
    ELSE
      metadata := jsonb_build_object('workspaceId', NEW.workspace_id, 'unitId', NEW.id, 'levelId', NEW.level_id,
        'fromParentId', from_parent, 'toParentId', NEW.parent_id);
    END IF;
    INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
    VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, action, split_part(action, '.', 1),
      CASE action
        WHEN 'org.level_created' THEN 'Created an organisation level'
        WHEN 'org.level_renamed' THEN 'Renamed an organisation level'
        WHEN 'org.level_archived' THEN 'Archived an organisation level'
        WHEN 'org.unit_created' THEN 'Created an organisation unit'
        WHEN 'org.unit_renamed' THEN 'Renamed an organisation unit'
        WHEN 'org.unit_moved' THEN 'Moved an organisation unit'
        WHEN 'org.unit_archived' THEN 'Archived an organisation unit'
        ELSE 'Changed the organisation units that set home units' END,
      metadata);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.audit_org_change() FROM PUBLIC;
CREATE TRIGGER org_levels_audit AFTER INSERT OR UPDATE ON app.org_levels
  FOR EACH ROW EXECUTE FUNCTION app.audit_org_change();
CREATE TRIGGER org_units_audit AFTER INSERT OR UPDATE ON app.org_units
  FOR EACH ROW EXECUTE FUNCTION app.audit_org_change();

-- As in 0030, plus: org and scope rows come only from the owner (app.audit_org_change above); no
-- runtime role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
        'org.unit_renamed', 'org.unit_moved', 'org.unit_archived')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'scope' AND action = 'scope.home_units_changed'
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The code now depends on these tables and triggers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 12;
