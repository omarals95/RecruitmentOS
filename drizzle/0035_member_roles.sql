-- Configured roles and member assignment (R2a-10, job 052). Apply after 0034_positions_employees.sql,
-- then rerun infrastructure/postgres-split-runtime-roles.sql, which grants the data role SELECT,
-- INSERT, UPDATE and DELETE on app.member_roles and EXECUTE on
-- tenant_context.role_assignment_changes. A member's configured role is the app.member_roles row,
-- written only by a company owner session; tenant_context.install narrows the stored scopes to the
-- asserted scopes intersected with that role's scopes, never widening them, and returns the role
-- version. Roles whose record scope is not all are refused until R2a-18 enforces record scope. The
-- storage schema marker goes to 14, so startup refuses a database without this migration.

-- Which configured role a member holds in a team (architecture 1.2, 3.3). No row: the built-in
-- template of member.role.
CREATE TABLE app.member_roles (
  team_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  role_object_id uuid NOT NULL REFERENCES app.config_objects(id),
  assigned_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX member_roles_role_idx ON app.member_roles(role_object_id);

-- Any context of the row's team reads; a session context of that team whose derived company level
-- is owner writes (allows_workspace area roles, 0030). Token and OAuth contexts, company admins and
-- team owners or admins without company authority write nothing.
DO $member_roles_rls$ DECLARE command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  write_rule text := 'tenant_context.allows(team_id, NULL, ''read'') AND tenant_context.allows_workspace('
    '(SELECT t.workspace_id FROM app.workspace_teams t WHERE t.team_id = member_roles.team_id), ''write'', ''roles'')';
BEGIN
  ALTER TABLE app.member_roles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app.member_roles FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON app.member_roles FROM PUBLIC;
  -- Owner-only access for the migration, the trigger functions, install and the owner's fixture cleanup.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.member_roles FOR %s %s', 'member_roles_owner_' || lower(command), command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  EXECUTE 'CREATE POLICY context_read ON app.member_roles FOR SELECT USING (tenant_context.allows(team_id, NULL, ''read''))';
  EXECUTE format('CREATE POLICY context_insert ON app.member_roles FOR INSERT WITH CHECK (%s)', write_rule);
  EXECUTE format('CREATE POLICY context_update ON app.member_roles FOR UPDATE USING (%s) WITH CHECK (%s)', write_rule, write_rule);
  EXECUTE format('CREATE POLICY context_delete ON app.member_roles FOR DELETE USING (%s)', write_rule);
END $member_roles_rls$;

-- The row names a current published role of the team's workspace whose membership is admin,
-- recruiter or viewer and whose record scope is all in every group (RQ011 otherwise, until R2a-18),
-- for a member of the team who is not a team owner; an update keeps the team and user. For any
-- caller with a context, the context is an unexpired session of the row's team whose company level
-- is owner (42501 otherwise). assigned_by and assigned_at are always the context actor and now, so
-- planted values are never stored. The owner's own SQL has no context row and skips the authority
-- check only. A security definer function, because only the owner reads the context table.
CREATE FUNCTION app.guard_member_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
  role_body jsonb;
BEGIN
  SELECT t.workspace_id INTO row_workspace FROM app.workspace_teams t WHERE t.team_id = NEW.team_id;
  NEW.assigned_by := NULL;
  IF EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()) THEN
    SELECT * INTO ctx FROM tenant_context.contexts c
      WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
        AND c.expires_at > clock_timestamp();
    IF NOT FOUND OR ctx.auth_type <> 'session' OR ctx.company_level IS DISTINCT FROM 'owner'
       OR ctx.team_id <> NEW.team_id OR ctx.workspace_id IS DISTINCT FROM row_workspace THEN
      RAISE EXCEPTION 'Only a company owner can assign roles' USING ERRCODE = '42501';
    END IF;
    NEW.assigned_by := ctx.actor_id;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.team_id, NEW.user_id) IS DISTINCT FROM (OLD.team_id, OLD.user_id) THEN
    RAISE EXCEPTION 'A role assignment keeps its team and member' USING ERRCODE = '42501';
  END IF;
  SELECT v.body INTO role_body FROM app.config_objects o JOIN app.config_versions v
      ON v.id = o.current_version_id AND v.object_id = o.id AND v.workspace_id = o.workspace_id AND v.state = 'published'
    WHERE o.id = NEW.role_object_id AND o.workspace_id = row_workspace AND o.type = 'role' AND o.archived_at IS NULL;
  IF NOT FOUND OR row_workspace IS NULL OR jsonb_typeof(role_body->'membership') IS DISTINCT FROM 'string'
     OR role_body->>'membership' NOT IN ('admin', 'recruiter', 'viewer') THEN
    RAISE EXCEPTION 'Assign a published role of this company' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(role_body->'recordScope') IS DISTINCT FROM 'object'
     OR role_body->'recordScope'->'pipeline' IS DISTINCT FROM '"all"'::jsonb
     OR role_body->'recordScope'->'candidates' IS DISTINCT FROM '"all"'::jsonb
     OR role_body->'recordScope'->'tasks' IS DISTINCT FROM '"all"'::jsonb THEN
    RAISE EXCEPTION 'Roles limited to a unit or to assigned records cannot be assigned yet' USING ERRCODE = 'RQ011';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.member m
      WHERE m.organization_id = NEW.team_id AND m.user_id = NEW.user_id AND m.role <> 'owner') THEN
    RAISE EXCEPTION 'Assign roles to team members who are not team owners' USING ERRCODE = '42501';
  END IF;
  NEW.assigned_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_member_role() FROM PUBLIC;
CREATE TRIGGER member_roles_guard BEFORE INSERT OR UPDATE ON app.member_roles
  FOR EACH ROW EXECUTE FUNCTION app.guard_member_role();

-- One role-assignment activity row per assignment, change and clear, written to the row's team with
-- the context actor. Metadata holds ids only: the workspace, the member, the role object and the
-- role's current version at that moment. The owner's own SQL has no context row and writes nothing.
CREATE FUNCTION app.audit_member_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  affected app.member_roles%ROWTYPE;
  current_version uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected := OLD;
  ELSE
    affected := NEW;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.team_id = affected.team_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT o.current_version_id INTO current_version FROM app.config_objects o
    WHERE o.id = affected.role_object_id AND o.workspace_id = ctx.workspace_id;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (affected.team_id, NULL, ctx.actor_id, 'session', NULL,
    CASE TG_OP WHEN 'DELETE' THEN 'role.cleared' ELSE 'role.assigned' END, 'role-assignment',
    CASE TG_OP WHEN 'DELETE' THEN 'Cleared a member''s configured role' ELSE 'Assigned a configured role to a member' END,
    jsonb_build_object('workspaceId', ctx.workspace_id, 'affectedUserId', affected.user_id,
      'roleObjectId', affected.role_object_id, 'roleVersionId', current_version));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.audit_member_role() FROM PUBLIC;
CREATE TRIGGER member_roles_audit AFTER INSERT OR UPDATE OR DELETE ON app.member_roles
  FOR EACH ROW EXECUTE FUNCTION app.audit_member_role();

-- Company owner sessions only (42501 otherwise, 22023 for a page size outside 1-100): the
-- role-assignment rows of every team mapped to the context's workspace, newest first, for the
-- company owners' home screen. Action, time, affected user id, the name in the role version named
-- in the row and the actor's name only: no team, record, token, object or version id.
CREATE FUNCTION tenant_context.role_assignment_changes(before timestamptz, page_size integer)
RETURNS TABLE (occurred_at timestamptz, action text, affected_user_id text, role_name text, actor_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS DISTINCT FROM 'owner' OR ctx.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Role assignment changes rejected' USING ERRCODE = '42501';
  END IF;
  IF role_assignment_changes.page_size IS NULL OR role_assignment_changes.page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Role assignment changes rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT a.created_at, a.action, a.metadata->>'affectedUserId', v.body->>'name', u.name
    FROM app.activity a
    JOIN app.workspace_teams t ON t.team_id = a.team_id
    LEFT JOIN app.config_versions v ON v.id::text = a.metadata->>'roleVersionId' AND v.workspace_id = ctx.workspace_id
    LEFT JOIN auth."user" u ON u.id = a.actor_id
    WHERE a.kind = 'role-assignment' AND a.action IN ('role.assigned', 'role.cleared') AND t.workspace_id = ctx.workspace_id
      AND a.metadata->>'workspaceId' = ctx.workspace_id::text
      AND (role_assignment_changes.before IS NULL OR a.created_at < role_assignment_changes.before)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT role_assignment_changes.page_size;
END $$;
REVOKE ALL ON FUNCTION tenant_context.role_assignment_changes(timestamptz, integer) FROM PUBLIC;

-- As in 0034, plus: role-assignment rows come only from the owner (app.audit_member_role above); no
-- runtime role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The role version a context was installed under (architecture 3.5).
ALTER TABLE tenant_context.contexts ADD COLUMN role_version_id uuid;

-- As in 0032, plus the role step after every existing check and before the context row: a member
-- without an app.member_roles row holds the built-in template of member.role (its fixed version id,
-- src/domain/config-defaults.ts) with the asserted scopes; a member with a row whose role is usable
-- (a current published role of the workspace, record scope all in every group) holds that version
-- with the asserted scopes intersected with the body's string scopes, in canonical order, never
-- widened; any other row stores no scopes and no version, so the context fails closed. The result
-- returns the stored scopes and roleVersionId.
CREATE OR REPLACE FUNCTION tenant_context.install(payload text, signature text, cached text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  known constant text[] := ARRAY['candidates:read','candidates:write','recruitment:read','recruitment:write','cvs:read','cvs:write','imports:write','directory:read','directory:write','plans:read','plans:write'];
  claim jsonb;
  pads record;
  asserted text[];
  now_ms bigint;
  member_role text;
  valid boolean;
  company uuid;
  level_held text;
  areas_held text[];
  plan_held boolean;
  current_versions jsonb;
  current_documents jsonb;
  assigned uuid;
  role_version uuid;
  role_body jsonb;
  stored text[];
BEGIN
  IF payload IS NULL OR signature IS NULL OR octet_length(payload) > 2048
     OR payload !~ '^[ -~]*$' OR strpos(payload, chr(92)) > 0 OR signature !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  BEGIN
    claim := payload::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END;
  IF jsonb_typeof(claim) IS DISTINCT FROM 'object' OR jsonb_typeof(claim->'kid') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  -- Verify the signature with a known, unretired key before any identity state is read.
  SELECT k.inner_pad, k.outer_pad INTO pads FROM tenant_context.keys k
    WHERE k.id = claim->>'kid' AND k.retired_at IS NULL;
  IF NOT FOUND OR encode(sha256(pads.outer_pad || sha256(pads.inner_pad || convert_to(payload, 'UTF8'))), 'hex') <> signature THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(claim->'scopes') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(claim->'scopes') e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  asserted := ARRAY(SELECT jsonb_array_elements_text(claim->'scopes'));
  now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  -- Rebuilding the canonical text enforces the exact field set, order and encoding.
  valid := jsonb_typeof(claim->'aud') = 'string' AND claim->>'aud' = 'recruitmentos-tenant-context-v1'
    AND jsonb_typeof(claim->'env') = 'string' AND claim->>'env' = (SELECT m.id::text FROM db_boundary.connection_marker m)
    AND jsonb_typeof(claim->'pid') = 'number' AND claim->>'pid' ~ '^[0-9]{1,10}$' AND (claim->>'pid')::bigint = pg_backend_pid()
    AND jsonb_typeof(claim->'xid') = 'string' AND claim->>'xid' = pg_current_xact_id()::text
    AND jsonb_typeof(claim->'team') = 'string' AND claim->>'team' ~ '^[A-Za-z0-9_.:@-]{1,128}$'
    AND jsonb_typeof(claim->'actor') = 'string' AND claim->>'actor' ~ '^[A-Za-z0-9_.:@-]{1,128}$'
    AND jsonb_typeof(claim->'auth') = 'string' AND claim->>'auth' IN ('session','token')
    AND CASE claim->>'auth'
      WHEN 'session' THEN jsonb_typeof(claim->'token') = 'null'
      ELSE jsonb_typeof(claim->'token') = 'string' AND claim->>'token' ~ '^[A-Za-z0-9_.:@-]{1,128}$' END
    AND asserted = ARRAY(SELECT s FROM unnest(known) WITH ORDINALITY AS k(s, n) WHERE s = ANY(asserted) ORDER BY n)
    AND jsonb_typeof(claim->'exp') = 'number' AND claim->>'exp' ~ '^[0-9]{1,15}$'
    AND (claim->>'exp')::bigint > now_ms AND (claim->>'exp')::bigint <= now_ms + 60000
    AND payload = '{"aud":' || to_json(claim->>'aud')::text || ',"kid":' || to_json(claim->>'kid')::text
      || ',"env":' || to_json(claim->>'env')::text || ',"pid":' || (claim->>'pid')
      || ',"xid":' || to_json(claim->>'xid')::text || ',"team":' || to_json(claim->>'team')::text
      || ',"actor":' || to_json(claim->>'actor')::text || ',"auth":' || to_json(claim->>'auth')::text
      || ',"token":' || coalesce(to_json(claim->>'token')::text, 'null')
      || ',"scopes":' || coalesce((SELECT '[' || string_agg(to_json(s)::text, ',' ORDER BY n) || ']' FROM unnest(asserted) WITH ORDINALITY AS a(s, n)), '[]')
      || ',"exp":' || (claim->>'exp') || '}'
    AND NOT EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id());
  IF valid IS NOT TRUE THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  -- Recheck current identity state; revocations committed after this take effect next transaction.
  SELECT m.role INTO member_role FROM auth."user" u
    JOIN auth.member m ON m.user_id = u.id
    WHERE u.id = claim->>'actor' AND m.organization_id = claim->>'team' AND u.email_verified
    FOR SHARE;
  IF NOT FOUND OR (asserted <@ CASE member_role
      WHEN 'owner' THEN known WHEN 'admin' THEN known WHEN 'recruiter' THEN ARRAY['candidates:read','candidates:write','recruitment:read','recruitment:write','cvs:read','cvs:write']
      WHEN 'viewer' THEN ARRAY['candidates:read','recruitment:read','cvs:read'] END) IS NOT TRUE THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  IF claim->>'auth' = 'token' THEN
    PERFORM 1 FROM auth.api_tokens t
      WHERE t.id = claim->>'token' AND t.user_id = claim->>'actor' AND t.team_id = claim->>'team'
        AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()
        AND asserted <@ ARRAY(SELECT jsonb_array_elements_text(t.scopes))
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- Only the verified team and actor select the rows; member.role grants no company authority.
  SELECT t.workspace_id INTO company FROM app.workspace_teams t WHERE t.team_id = claim->>'team';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  SELECT a.level, a.areas, a.plan_access INTO level_held, areas_held, plan_held FROM app.workspace_admins a
    WHERE a.workspace_id = company AND a.user_id = claim->>'actor' AND a.suspended_at IS NULL;
  -- The member's configured role narrows the asserted scopes; it never adds one.
  SELECT r.role_object_id INTO assigned FROM app.member_roles r
    WHERE r.team_id = claim->>'team' AND r.user_id = claim->>'actor';
  IF NOT FOUND THEN
    role_version := CASE member_role WHEN 'owner' THEN '00000000-0000-4000-8000-000000000101'::uuid
      WHEN 'admin' THEN '00000000-0000-4000-8000-000000000102'::uuid
      WHEN 'recruiter' THEN '00000000-0000-4000-8000-000000000103'::uuid
      WHEN 'viewer' THEN '00000000-0000-4000-8000-000000000104'::uuid END;
    stored := asserted;
  ELSE
    SELECT v.id, v.body INTO role_version, role_body FROM app.config_objects o JOIN app.config_versions v
        ON v.id = o.current_version_id AND v.object_id = o.id AND v.workspace_id = o.workspace_id AND v.state = 'published'
      WHERE o.id = assigned AND o.workspace_id = company AND o.type = 'role' AND o.archived_at IS NULL
        AND jsonb_typeof(v.body->'recordScope') = 'object'
        AND v.body->'recordScope'->'pipeline' = '"all"'::jsonb AND v.body->'recordScope'->'candidates' = '"all"'::jsonb
        AND v.body->'recordScope'->'tasks' = '"all"'::jsonb;
    IF FOUND THEN
      stored := ARRAY(SELECT s FROM unnest(asserted) WITH ORDINALITY AS a(s, n)
        WHERE jsonb_typeof(role_body->'scopes') = 'array'
          AND to_jsonb(s) IN (SELECT e FROM jsonb_array_elements(role_body->'scopes') e WHERE jsonb_typeof(e) = 'string')
        ORDER BY n);
    ELSE
      role_version := NULL;
      stored := '{}';
    END IF;
  END IF;
  -- Bounded purge: committed contexts are never matched again because an xid8 is never reused.
  DELETE FROM tenant_context.contexts c WHERE (c.pid, c.xid) IN (
    SELECT o.pid, o.xid FROM tenant_context.contexts o WHERE o.expires_at <= clock_timestamp()
    ORDER BY o.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
  INSERT INTO tenant_context.contexts(pid, xid, team_id, actor_id, auth_type, token_id, scopes, expires_at,
    workspace_id, member_role, company_level, company_areas, plan_access, role_version_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), claim->>'team', claim->>'actor', claim->>'auth',
    claim->>'token', stored, to_timestamp((claim->>'exp')::bigint / 1000.0),
    company, member_role, level_held, coalesce(areas_held, '{}'), coalesce(plan_held, false), role_version);
  -- Every check has passed and the context row is stored. The current published versions of the
  -- derived workspace: company objects and the verified team's task boards, never another team's.
  SELECT coalesce(jsonb_object_agg(o.id::text, v.id::text), '{}') INTO current_versions
    FROM app.config_objects o JOIN app.config_versions v
      ON v.id = o.current_version_id AND v.object_id = o.id AND v.workspace_id = o.workspace_id AND v.state = 'published'
    WHERE o.workspace_id = company AND o.archived_at IS NULL AND (o.team_id IS NULL OR o.team_id = claim->>'team');
  -- The unsigned hint only drops bodies: an id that is not one of these versions matches nothing.
  SELECT coalesce(jsonb_agg(jsonb_build_object('versionId', v.id::text, 'objectId', o.id::text, 'type', o.type,
      'key', o.key, 'number', v.number, 'bodySha256', v.body_sha256, 'body', v.body::text) ORDER BY v.id), '[]')
    INTO current_documents
    FROM app.config_objects o JOIN app.config_versions v
      ON v.id = o.current_version_id AND v.object_id = o.id AND v.workspace_id = o.workspace_id AND v.state = 'published'
    WHERE o.workspace_id = company AND o.archived_at IS NULL AND (o.team_id IS NULL OR o.team_id = claim->>'team')
      AND NOT EXISTS (SELECT 1 FROM unnest(cached) h(id) WHERE h.id = v.id::text);
  RETURN jsonb_build_object('scopes', to_jsonb(stored), 'workspaceId', company::text, 'memberRole', member_role,
    'companyLevel', level_held, 'companyAreas', to_jsonb(coalesce(areas_held, '{}')),
    'versions', current_versions, 'documents', current_documents, 'roleVersionId', role_version::text);
END $$;
REVOKE ALL ON FUNCTION tenant_context.install(text, text, text[]) FROM PUBLIC;

-- The code now depends on the table, the role step in install and the owner-only read; startup
-- refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 14;
