-- Versioned configuration store and configuration audit (R2a-04, job 044). Apply after
-- 0029_signed_context_workspace.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which
-- grants the data role SELECT, INSERT, UPDATE and DELETE on the three new tables and EXECUTE on the
-- five new helpers below. The storage schema marker goes to 9, so startup refuses a database without
-- this migration. Team tables, their policies and tenant_context.install are unchanged.

-- Company configuration keyed by workspace (D1). Only task-board objects carry a team; that team
-- alone reads them. Versions are immutable once published; layouts are editor-only.
CREATE TABLE app.config_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  team_id text REFERENCES auth.organization(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('kind-schema','workflow','board','role','template','task-board')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  current_version_id uuid,
  draft_version_id uuid,
  created_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT config_objects_team_check CHECK ((team_id IS NOT NULL) = (type = 'task-board')),
  CONSTRAINT config_objects_key_unique UNIQUE NULLS NOT DISTINCT (workspace_id, team_id, type, key),
  UNIQUE (id, workspace_id)
);
CREATE TABLE app.config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  number integer CHECK (number > 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  published_at timestamptz,
  note text CHECK (char_length(note) <= 500),
  CONSTRAINT config_versions_draft_number_check CHECK ((number IS NULL) = (state = 'draft')),
  CONSTRAINT config_versions_number_unique UNIQUE (object_id, number),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (object_id, workspace_id) REFERENCES app.config_objects(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX config_versions_one_draft ON app.config_versions(object_id) WHERE state = 'draft';
CREATE TABLE app.config_layouts (
  version_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  layout jsonb NOT NULL CHECK (octet_length(layout::text) <= 524288),
  updated_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (version_id, workspace_id) REFERENCES app.config_versions(id, workspace_id) ON DELETE CASCADE
);
-- The audit helper's one-shot checks and the history helper read config rows by object.
CREATE INDEX activity_config_object_idx ON app.activity ((metadata->>'objectId'), created_at DESC)
  WHERE kind = 'config';

-- Policy predicate for the three tables: the current context's derived workspace is the row's and,
-- for write, a session whose company authority covers the area, or for a task board a team owner
-- or admin. The caller adds the task-board team check.
CREATE FUNCTION tenant_context.allows_workspace(row_workspace uuid, access text, area text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace
      AND area IN ('fields','workflows','boards','organisation','templates','roles','task-board')
      AND CASE access WHEN 'read' THEN true
        WHEN 'write' THEN c.auth_type = 'session' AND CASE area
          WHEN 'roles' THEN c.company_level = 'owner'
          WHEN 'task-board' THEN c.member_role IN ('owner','admin')
          ELSE c.company_level = 'owner' OR area = ANY(c.company_areas) END
        ELSE false END)
$$;
REVOKE ALL ON FUNCTION tenant_context.allows_workspace(uuid, text, text) FROM PUBLIC;

DO $config_rls$ DECLARE tbl text; command text; access text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  -- %1$s is the object row prefix, %2$L the access. Roles need a company owner (allows_workspace).
  object_rule text := 'tenant_context.allows_workspace(%1$sworkspace_id, %2$L, CASE %1$stype WHEN ''kind-schema'' THEN ''fields'' '
    'WHEN ''workflow'' THEN ''workflows'' WHEN ''board'' THEN ''boards'' WHEN ''template'' THEN ''templates'' '
    'WHEN ''role'' THEN ''roles'' WHEN ''task-board'' THEN ''task-board'' END) '
    'AND (%1$steam_id IS NULL OR tenant_context.allows(%1$steam_id, NULL, ''read''))';
  rules text[];
BEGIN
 FOREACH tbl IN ARRAY ARRAY['config_objects','config_versions','config_layouts'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', tbl);
  -- Owner-only access for the migration, the helpers and the owner's fixture cleanup, as in 0028.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'config_owner_' || lower(command), tbl, command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
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
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (%s)', tbl, rules[1]);
  EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', tbl, rules[2]);
  EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, rules[2], rules[2]);
  EXECUTE format('CREATE POLICY context_delete ON app.%I FOR DELETE USING (%s)', tbl, rules[2]);
 END LOOP;
END $config_rls$;

-- Immutability. A security invoker function, like app.prevent_activity_mutation, so current_user is
-- the caller: a runtime role, or the owner inside an owner-run helper. Published and retired bodies
-- never change; only the owner changes state (draft to published, published to retired) or deletes
-- a published or retired version. The body hash is always computed here.
CREATE FUNCTION app.guard_config_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner boolean := current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' AND NOT owner THEN
      RAISE EXCEPTION 'Published configuration versions cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF octet_length(NEW.body::text) > 524288 THEN
    RAISE EXCEPTION 'The configuration body is too large' USING ERRCODE = '54000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT owner AND (NEW.state <> 'draft' OR NEW.number IS NOT NULL OR NEW.published_by IS NOT NULL
        OR NEW.published_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Only a draft can be created' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF OLD.state <> 'draft' AND (NEW.body, NEW.body_sha256, NEW.number, NEW.object_id)
        IS DISTINCT FROM (OLD.body, OLD.body_sha256, OLD.number, OLD.object_id) THEN
      RAISE EXCEPTION 'Published configuration versions are immutable' USING ERRCODE = '42501';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT (owner AND (OLD.state, NEW.state) IN (('draft','published'), ('published','retired'))) THEN
      RAISE EXCEPTION 'Configuration state change rejected' USING ERRCODE = '42501';
    END IF;
    IF NOT owner AND (OLD.state <> 'draft'
        OR (NEW.id, NEW.object_id, NEW.workspace_id, NEW.number, NEW.created_by, NEW.created_at, NEW.published_by, NEW.published_at)
          IS DISTINCT FROM (OLD.id, OLD.object_id, OLD.workspace_id, OLD.number, OLD.created_by, OLD.created_at, OLD.published_by, OLD.published_at)) THEN
      RAISE EXCEPTION 'Only a draft body or note can be edited' USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'draft' THEN
      RETURN NEW;
    END IF;
  END IF;
  NEW.body_sha256 := encode(sha256(convert_to(NEW.body::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_config_version() FROM PUBLIC;
CREATE TRIGGER config_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON app.config_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_config_version();

-- The same for objects: identity columns never change for a runtime role, only the owner (the
-- publish helper) moves the current version, the draft pointer names a draft of the object, archiving
-- is one-way, and a runtime role cannot delete an object with a published or retired version.
CREATE FUNCTION app.guard_config_object() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner boolean := current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT owner AND EXISTS (SELECT 1 FROM app.config_versions v WHERE v.object_id = OLD.id AND v.state <> 'draft') THEN
      RAISE EXCEPTION 'Published configuration versions cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT owner AND (NEW.current_version_id IS NOT NULL OR NEW.draft_version_id IS NOT NULL OR NEW.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Configuration object rejected' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT owner AND ((NEW.id, NEW.workspace_id, NEW.team_id, NEW.type, NEW.key, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.team_id, OLD.type, OLD.key, OLD.created_by, OLD.created_at)
      OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) THEN
    RAISE EXCEPTION 'Configuration object rejected' USING ERRCODE = '42501';
  END IF;
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND (OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL) THEN
    RAISE EXCEPTION 'An archived configuration object stays archived' USING ERRCODE = '42501';
  END IF;
  IF NEW.draft_version_id IS DISTINCT FROM OLD.draft_version_id AND NEW.draft_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.config_versions v
       WHERE v.id = NEW.draft_version_id AND v.object_id = NEW.id AND v.state = 'draft') THEN
    RAISE EXCEPTION 'The draft pointer must name a draft of this object' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_config_object() FROM PUBLIC;
CREATE TRIGGER config_objects_guard BEFORE INSERT OR UPDATE OR DELETE ON app.config_objects
  FOR EACH ROW EXECUTE FUNCTION app.guard_config_object();

-- The writing actor comes from the verified context, never from the row: created_by on objects and
-- versions, updated_by on layouts. A security definer function, because only the owner reads the
-- context table; a write with no context (the owner's own SQL) keeps its values.
CREATE FUNCTION app.stamp_config_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text;
BEGIN
  SELECT c.actor_id INTO actor FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF FOUND AND TG_TABLE_NAME = 'config_layouts' THEN
    NEW.updated_by := actor;
  ELSIF FOUND AND TG_OP = 'INSERT' THEN
    NEW.created_by := actor;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.stamp_config_actor() FROM PUBLIC;
CREATE TRIGGER config_objects_stamp BEFORE INSERT ON app.config_objects
  FOR EACH ROW EXECUTE FUNCTION app.stamp_config_actor();
CREATE TRIGGER config_versions_stamp BEFORE INSERT ON app.config_versions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_config_actor();
CREATE TRIGGER config_layouts_stamp BEFORE INSERT OR UPDATE ON app.config_layouts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_config_actor();

-- Session contexts with write authority on the version's object only (allows_workspace, and for a
-- task board the context's own team): 42501 otherwise, 22023 for an unknown action, RQ007 when the
-- rows do not show the action or it was already audited. Writes one config activity row to the
-- acting team; its metadata comes from the rows and never holds the body, layout or note.
CREATE FUNCTION tenant_context.audit_config(version_id uuid, action text) RETURNS void
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
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' END) THEN
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
REVOKE ALL ON FUNCTION tenant_context.audit_config(uuid, text) FROM PUBLIC;

-- Session contexts with write authority on the object, as in audit_config: 42501 otherwise, RQ007
-- unless the version is the draft of an unarchived object. Under the object's row lock it assigns
-- the next number, makes the version current and audits it; older versions stay as they are.
CREATE FUNCTION tenant_context.publish_config_version(version_id uuid) RETURNS integer
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
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' END) THEN
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
REVOKE ALL ON FUNCTION tenant_context.publish_config_version(uuid) FROM PUBLIC;

-- The same checks as publish; RQ007 unless the version is published and not the object's current
-- version, which always stays a published one.
CREATE FUNCTION tenant_context.retire_config_version(version_id uuid) RETURNS void
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
       WHEN 'role' THEN 'roles' WHEN 'task-board' THEN 'task-board' END) THEN
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
REVOKE ALL ON FUNCTION tenant_context.retire_config_version(uuid) FROM PUBLIC;

-- Company owner and admin sessions only (42501 otherwise, 22023 for a page size outside 1-100):
-- config rows of every team mapped to the context's workspace, newest first, except other teams'
-- task-board rows. Metadata only: no team, user, object, version or record id, token or body.
CREATE FUNCTION tenant_context.config_history(object_id uuid, before timestamptz, page_size integer)
RETURNS TABLE (occurred_at timestamptz, action text, object_type text, object_key text, version_number integer,
  from_version_number integer, actor_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS NULL OR ctx.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Configuration history rejected' USING ERRCODE = '42501';
  END IF;
  IF config_history.page_size IS NULL OR config_history.page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Configuration history rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT a.created_at, a.action, a.metadata->>'type', a.metadata->>'key', (a.metadata->>'number')::integer,
      (SELECT f.number FROM app.config_versions f WHERE f.id = (a.metadata->>'fromVersionId')::uuid), u.name
    FROM app.activity a
    JOIN app.workspace_teams t ON t.team_id = a.team_id
    LEFT JOIN auth."user" u ON u.id = a.actor_id
    WHERE a.kind = 'config' AND t.workspace_id = ctx.workspace_id AND a.metadata->>'workspaceId' = ctx.workspace_id::text
      AND (a.metadata->>'type' IS DISTINCT FROM 'task-board' OR a.team_id = ctx.team_id)
      AND (config_history.object_id IS NULL OR a.metadata->>'objectId' = config_history.object_id::text)
      AND (config_history.before IS NULL OR a.created_at < config_history.before)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT config_history.page_size;
END $$;
REVOKE ALL ON FUNCTION tenant_context.config_history(uuid, timestamptz, integer) FROM PUBLIC;

-- As in 0028, plus: config rows come only from the owner (the helpers above); no runtime role
-- inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The code now depends on these tables and helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 9;
