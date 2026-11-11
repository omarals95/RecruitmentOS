-- Team archive and restore (ADM-05, job 078). Apply after 0043_company_authority_two_step.sql, then
-- rerun infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on the
-- two new helpers tenant_context.set_team_archived and tenant_context.member_archived_teams, and again
-- on tenant_context.workspace_team_list, which this migration drops and creates with a new column;
-- the identity role gets nothing. A team owner archives their own team through the owner-run helper:
-- install then stores only the read scopes of every context of that team, so the coarse write gate of
-- tenant_context.allows refuses every write, and allows_workspace refuses its task-board writes.
-- Nothing is deleted or rewritten; restoring clears the two columns. An archive applies from the next
-- transaction. The storage schema marker goes to 22, so startup refuses a database without this
-- migration.

-- Both null (active) or both set (archived). No runtime role gains any write on the table.
ALTER TABLE app.workspace_teams ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text,
  ADD CONSTRAINT workspace_teams_archived_check CHECK ((archived_at IS NULL) = (archived_by IS NULL));

-- CV storage settings stay with a team's owners and admins while it is archived, but their helpers
-- create the team's usage row with INSERT ... ON CONFLICT DO NOTHING, which the write gate of a
-- read-only context refuses. The owner gets INSERT on app.storage_usage, as 0007 gave it SELECT and
-- UPDATE; every helper that inserts the row checks its caller first, and the storage_usage_owner_only
-- trigger still keeps every runtime role from writing the table.
CREATE POLICY ledger_owner_insert ON app.storage_usage FOR INSERT WITH CHECK (
  current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'));

-- Owner-run: a session context of an owner of that same team only (42501 otherwise, null arguments
-- 22023). Locks the team's row; the same state returns false and writes nothing; a change sets or
-- clears both columns and writes one team-archive activity row through the owner-only branch of the
-- insert policy. No other row is deleted or rewritten.
CREATE FUNCTION tenant_context.set_team_archived(team_id text, archived boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  target app.workspace_teams%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.member_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Team archive rejected' USING ERRCODE = '42501';
  END IF;
  IF set_team_archived.team_id IS NULL OR set_team_archived.archived IS NULL THEN
    RAISE EXCEPTION 'Team archive rejected' USING ERRCODE = '22023';
  END IF;
  IF ctx.team_id <> set_team_archived.team_id THEN
    RAISE EXCEPTION 'Team archive rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM app.workspace_teams t WHERE t.team_id = ctx.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team archive rejected' USING ERRCODE = '42501';
  END IF;
  IF (target.archived_at IS NOT NULL) = set_team_archived.archived THEN
    RETURN false;
  END IF;
  UPDATE app.workspace_teams t
    SET archived_at = CASE WHEN set_team_archived.archived THEN clock_timestamp() END,
      archived_by = CASE WHEN set_team_archived.archived THEN ctx.actor_id END
    WHERE t.team_id = ctx.team_id;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL,
    CASE WHEN set_team_archived.archived THEN 'team.archived' ELSE 'team.restored' END, 'team-archive',
    CASE WHEN set_team_archived.archived THEN 'Archived the team' ELSE 'Restored the team' END, '{}');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.set_team_archived(text, boolean) FROM PUBLIC;

-- As in 0037, plus the archive step: the team's archived state is read in the existing
-- app.workspace_teams statement, a context of an archived team stores only the :read scopes of
-- stored, in their order, and the result gains teamArchived. Every other check and output is the same.
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
  team_archived boolean;
  level_held text;
  areas_held text[];
  plan_held boolean;
  current_versions jsonb;
  current_documents jsonb;
  assigned uuid;
  role_version uuid;
  role_body jsonb;
  stored text[];
  record_scope_held jsonb;
  home uuid[];
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
  -- An archive committed after this statement applies from the next transaction.
  SELECT t.workspace_id, t.archived_at IS NOT NULL INTO company, team_archived FROM app.workspace_teams t
    WHERE t.team_id = claim->>'team';
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
    record_scope_held := '{"pipeline":"all","candidates":"all","tasks":"all"}'::jsonb;
  ELSE
    SELECT v.id, v.body INTO role_version, role_body FROM app.config_objects o JOIN app.config_versions v
        ON v.id = o.current_version_id AND v.object_id = o.id AND v.workspace_id = o.workspace_id AND v.state = 'published'
      WHERE o.id = assigned AND o.workspace_id = company AND o.type = 'role' AND o.archived_at IS NULL
        AND jsonb_typeof(v.body->'scopes') = 'array' AND jsonb_typeof(v.body->'recordScope') = 'object'
        AND v.body->'recordScope'->'pipeline' IN ('"all"'::jsonb, '"unit"'::jsonb, '"assigned"'::jsonb)
        AND v.body->'recordScope'->'candidates' IN ('"all"'::jsonb, '"unit"'::jsonb, '"assigned"'::jsonb)
        AND v.body->'recordScope'->'tasks' IN ('"all"'::jsonb, '"unit"'::jsonb, '"assigned"'::jsonb);
    IF FOUND THEN
      stored := ARRAY(SELECT s FROM unnest(asserted) WITH ORDINALITY AS a(s, n)
        WHERE to_jsonb(s) IN (SELECT e FROM jsonb_array_elements(role_body->'scopes') e WHERE jsonb_typeof(e) = 'string')
        ORDER BY n);
      record_scope_held := jsonb_build_object('pipeline', role_body->'recordScope'->'pipeline',
        'candidates', role_body->'recordScope'->'candidates', 'tasks', role_body->'recordScope'->'tasks');
    ELSE
      role_version := NULL;
      stored := '{}';
      record_scope_held := NULL;
    END IF;
  END IF;
  -- An archived team is read-only for every context: no write scope is stored.
  IF team_archived THEN
    stored := ARRAY(SELECT s FROM unnest(stored) WITH ORDINALITY AS a(s, n) WHERE s LIKE '%:read' ORDER BY n);
  END IF;
  -- Home units, from rows only a company owner can change (app.guard_scope_sources).
  home := ARRAY(SELECT DISTINCT p.org_unit_id FROM app.employees e
    JOIN app.employee_positions ep ON ep.employee_id = e.id AND ep.workspace_id = e.workspace_id AND ep.valid_to IS NULL
    JOIN app.positions p ON p.id = ep.position_id AND p.workspace_id = e.workspace_id
      AND p.valid_to IS NULL AND p.archived_at IS NULL
    WHERE e.workspace_id = company AND e.user_id = claim->>'actor'
    ORDER BY 1);
  -- Bounded purge: committed contexts are never matched again because an xid8 is never reused.
  DELETE FROM tenant_context.contexts c WHERE (c.pid, c.xid) IN (
    SELECT o.pid, o.xid FROM tenant_context.contexts o WHERE o.expires_at <= clock_timestamp()
    ORDER BY o.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
  INSERT INTO tenant_context.contexts(pid, xid, team_id, actor_id, auth_type, token_id, scopes, expires_at,
    workspace_id, member_role, company_level, company_areas, plan_access, role_version_id, record_scope, home_units)
  VALUES (pg_backend_pid(), pg_current_xact_id(), claim->>'team', claim->>'actor', claim->>'auth',
    claim->>'token', stored, to_timestamp((claim->>'exp')::bigint / 1000.0),
    company, member_role, level_held, coalesce(areas_held, '{}'), coalesce(plan_held, false), role_version,
    record_scope_held, home);
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
    'versions', current_versions, 'documents', current_documents, 'roleVersionId', role_version::text,
    'recordScope', record_scope_held, 'homeUnits', to_jsonb(home), 'teamArchived', team_archived);
END $$;

-- As in 0030, plus: a task-board write also needs the context's team not to be archived. CREATE OR
-- REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.allows_workspace(row_workspace uuid, access text, area text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace
      AND area IN ('fields','workflows','boards','organisation','templates','roles','task-board')
      AND CASE access WHEN 'read' THEN true
        WHEN 'write' THEN c.auth_type = 'session' AND CASE area
          WHEN 'roles' THEN c.company_level = 'owner'
          WHEN 'task-board' THEN c.member_role IN ('owner','admin')
            AND NOT EXISTS (SELECT 1 FROM app.workspace_teams t WHERE t.team_id = c.team_id AND t.archived_at IS NOT NULL)
          ELSE c.company_level = 'owner' OR area = ANY(c.company_areas) END
        ELSE false END)
$$;

-- As in 0037, plus: team-archive rows come only from the owner (tenant_context.set_team_archived).
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment', 'team-archive') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND employee_erasure_id IS NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'employee-erasure' AND action = 'employee.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- As in 0041, plus each team's archived state. The return type changes, so the function is dropped
-- and created again; the role template grants it to the data role again.
DROP FUNCTION tenant_context.workspace_team_list();
CREATE FUNCTION tenant_context.workspace_team_list()
RETURNS TABLE (id text, name text, slug text, created_at timestamptz, archived boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS NULL OR ctx.company_level NOT IN ('owner', 'admin') OR ctx.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Workspace team list rejected' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT o.id, o.name, o.slug, o.created_at, t.archived_at IS NOT NULL
    FROM app.workspace_teams t
    JOIN auth.organization o ON o.id = t.team_id
    WHERE t.workspace_id = ctx.workspace_id
    ORDER BY o.name, o.slug;
END $$;
REVOKE ALL ON FUNCTION tenant_context.workspace_team_list() FROM PUBLIC;

-- Session contexts only (42501 otherwise): the ids of the archived teams of the context's workspace
-- in which the context's actor is currently a member, for the team switcher and the Teams list.
-- Nothing about a team the actor is not in.
CREATE FUNCTION tenant_context.member_archived_teams() RETURNS TABLE (team_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Archived team list rejected' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT t.team_id FROM app.workspace_teams t
    WHERE t.workspace_id = ctx.workspace_id AND t.archived_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM auth.member m WHERE m.organization_id = t.team_id AND m.user_id = ctx.actor_id)
    ORDER BY t.team_id;
END $$;
REVOKE ALL ON FUNCTION tenant_context.member_archived_teams() FROM PUBLIC;

-- The code now reads the archived state and calls the two helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 22;
