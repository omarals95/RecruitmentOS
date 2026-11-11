-- User deactivation, sign out everywhere and clear lockout (ADM-09, job 082). Apply after
-- 0046_workspace_person.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which grants
-- the data role SELECT on the new table app.workspace_users and EXECUTE on the new helper
-- tenant_context.set_user_active and again on tenant_context.workspace_person, which this migration
-- drops and creates with a new column, and the identity role EXECUTE on the new helper
-- tenant_context.user_account_action. A company owner, or a company admin with people, deactivates
-- or reactivates a person for the whole workspace: install then refuses every session, API token and
-- MCP OAuth grant of that person with 42501 Account deactivated, from the next transaction. Nothing
-- of the person's memberships, roles, assignments, authority, tokens, sessions or history is deleted
-- or rewritten; reactivating clears the two columns. The two actions end the person's sessions or
-- record that their sign-in backoff was cleared. Only a company owner changes someone with company
-- authority, nobody changes themselves, and the last active company owner is never deactivated. The
-- storage schema marker goes to 25, so startup refuses a database without this migration.

-- One row per person a change ever touched: both null (active) or both set (deactivated). No runtime
-- role gains any write on the table.
CREATE TABLE app.workspace_users (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  deactivated_at timestamptz,
  deactivated_by text,
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_users_deactivated_check CHECK ((deactivated_at IS NULL) = (deactivated_by IS NULL))
);

-- The owner-only policies of 0028.
DO $workspace_users_rls$ DECLARE command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
  ALTER TABLE app.workspace_users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app.workspace_users FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON app.workspace_users FROM PUBLIC;
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.workspace_users FOR %s %s', 'workspace_owner_' || lower(command), command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
END $workspace_users_rls$;

-- As app.workspace_admins' read policy: contexts holding unsuspended company authority in the row's
-- workspace, and the person's own row. The owner reads through workspace_owner_select.
CREATE POLICY context_read ON app.workspace_users FOR SELECT USING (
  current_user <> (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
  AND tenant_context.allows_workspace_admin(workspace_id, user_id));

-- Owner-only rules of both helpers below, never executable by a runtime role. A session context of
-- a company owner or of a company admin holding people (42501 otherwise); invalid arguments or a
-- null, empty or over-long id 22023; a target with a membership in a team of the context's
-- workspace (RQ006 otherwise). Then the workspace row is locked, one change at a time as in
-- set_workspace_authority, and the caller must still hold that authority, unsuspended and not
-- deactivated, and must be a company owner when the target holds any company authority row of the
-- workspace, suspended or not (42501 otherwise). Returns the context.
CREATE FUNCTION tenant_context.account_change_context(target_user_id text, arguments_valid boolean)
RETURNS tenant_context.contexts
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  level_held text;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL OR ctx.company_level IS NULL
     OR NOT (ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas))) THEN
    RAISE EXCEPTION 'User account change rejected' USING ERRCODE = '42501';
  END IF;
  IF arguments_valid IS NOT TRUE OR target_user_id IS NULL OR target_user_id = '' OR length(target_user_id) > 128 THEN
    RAISE EXCEPTION 'User account change rejected' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM auth.member m JOIN app.workspace_teams t ON t.team_id = m.organization_id
    WHERE m.user_id = target_user_id AND t.workspace_id = ctx.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The member is in no team of this company' USING ERRCODE = 'RQ006';
  END IF;
  -- The caller may have lost authority, or been deactivated, while waiting.
  PERFORM 1 FROM app.workspaces w WHERE w.id = ctx.workspace_id FOR UPDATE;
  SELECT a.level INTO level_held FROM app.workspace_admins a
    WHERE a.workspace_id = ctx.workspace_id AND a.user_id = ctx.actor_id AND a.suspended_at IS NULL
      AND (a.level = 'owner' OR 'people' = ANY(a.areas))
      AND NOT EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = a.workspace_id
        AND d.user_id = a.user_id AND d.deactivated_at IS NOT NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User account change rejected' USING ERRCODE = '42501';
  END IF;
  IF level_held <> 'owner' AND EXISTS (SELECT 1 FROM app.workspace_admins a
       WHERE a.workspace_id = ctx.workspace_id AND a.user_id = target_user_id) THEN
    RAISE EXCEPTION 'User account change rejected' USING ERRCODE = '42501';
  END IF;
  RETURN ctx;
END $$;
REVOKE ALL ON FUNCTION tenant_context.account_change_context(text, boolean) FROM PUBLIC;

-- Owner-run, for the data role: deactivates (active false) or reactivates (true) the target in the
-- context's workspace under the rules above (a null active is 22023). Deactivating an unsuspended
-- company owner needs another unsuspended, active company owner (RQ005); the target may not be the
-- caller (RQ018). The same state returns false and writes nothing; a change upserts the row, setting
-- or clearing both columns, writes one user-account activity row with the target's id only and
-- returns true. No membership, role, assignment, authority, session, token or activity row changes.
CREATE FUNCTION tenant_context.set_user_active(target_user_id text, active boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.account_change_context(set_user_active.target_user_id,
    set_user_active.active IS NOT NULL);
  IF NOT set_user_active.active AND EXISTS (SELECT 1 FROM app.workspace_admins a
       WHERE a.workspace_id = ctx.workspace_id AND a.user_id = set_user_active.target_user_id
         AND a.level = 'owner' AND a.suspended_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.workspace_id = ctx.workspace_id
       AND a.user_id <> set_user_active.target_user_id AND a.level = 'owner' AND a.suspended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = a.workspace_id
         AND d.user_id = a.user_id AND d.deactivated_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'The last active company owner cannot be deactivated' USING ERRCODE = 'RQ005';
  END IF;
  IF set_user_active.target_user_id = ctx.actor_id THEN
    RAISE EXCEPTION 'You cannot change your own account' USING ERRCODE = 'RQ018';
  END IF;
  IF set_user_active.active = (NOT EXISTS (SELECT 1 FROM app.workspace_users d
       WHERE d.workspace_id = ctx.workspace_id AND d.user_id = set_user_active.target_user_id
         AND d.deactivated_at IS NOT NULL)) THEN
    RETURN false;
  END IF;
  INSERT INTO app.workspace_users(workspace_id, user_id, deactivated_at, deactivated_by)
  VALUES (ctx.workspace_id, set_user_active.target_user_id,
    CASE WHEN NOT set_user_active.active THEN clock_timestamp() END,
    CASE WHEN NOT set_user_active.active THEN ctx.actor_id END)
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET deactivated_at = EXCLUDED.deactivated_at,
    deactivated_by = EXCLUDED.deactivated_by;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL,
    CASE WHEN set_user_active.active THEN 'user.reactivated' ELSE 'user.deactivated' END, 'user-account',
    CASE WHEN set_user_active.active THEN 'Reactivated a member''s account' ELSE 'Deactivated a member''s account' END,
    jsonb_build_object('targetUserId', set_user_active.target_user_id));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.set_user_active(text, boolean) FROM PUBLIC;

-- Owner-run, for the identity role: sign_out deletes every session of the target; clear_lockout only
-- records the change, since the app deletes the keyed backoff row in the same transaction. The rules
-- above apply (any other action is 22023), and the target may not be the caller (RQ018). Each call
-- writes one user-account activity row with the target's id only.
CREATE FUNCTION tenant_context.user_account_action(target_user_id text, action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.account_change_context(user_account_action.target_user_id,
    user_account_action.action IN ('sign_out', 'clear_lockout'));
  IF user_account_action.target_user_id = ctx.actor_id THEN
    RAISE EXCEPTION 'You cannot change your own account' USING ERRCODE = 'RQ018';
  END IF;
  IF user_account_action.action = 'sign_out' THEN
    DELETE FROM auth.session s WHERE s.user_id = user_account_action.target_user_id;
  END IF;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL,
    CASE WHEN user_account_action.action = 'sign_out' THEN 'user.signed_out_everywhere' ELSE 'user.lockout_cleared' END,
    'user-account',
    CASE WHEN user_account_action.action = 'sign_out' THEN 'Signed a member out everywhere'
      ELSE 'Cleared a member''s sign-in lockout' END,
    jsonb_build_object('targetUserId', user_account_action.target_user_id));
END $$;
REVOKE ALL ON FUNCTION tenant_context.user_account_action(text, text) FROM PUBLIC;

-- As in 0044, plus the deactivation step: after the app.workspace_teams lookup, an actor with a
-- deactivated app.workspace_users row in that workspace is refused with the distinct message
-- Account deactivated, in the same statement. Every other check, refusal and output is the same.
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
  -- A deactivated person gets no context in the workspace; as for an archive, a deactivation
  -- committed after this statement applies from the next transaction.
  IF EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = company
       AND d.user_id = claim->>'actor' AND d.deactivated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Account deactivated' USING ERRCODE = '42501';
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

-- As in 0044, plus: user-account rows come only from the owner (the two helpers above).
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment', 'team-archive', 'user-account') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND employee_erasure_id IS NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'employee-erasure' AND action = 'employee.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- As in 0043, except that the remaining owner the last-owner check needs must also not be
-- deactivated, so removing or demoting an owner never leaves only deactivated owners. CREATE OR
-- REPLACE keeps its grants.
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
        ELSE new_areas <@ ARRAY['fields','workflows','boards','organisation','templates','people'] END
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

-- As in 0042, except that a person with a deactivated app.workspace_users row of the context's
-- workspace has the state deactivated, which the status argument also accepts. Same signature and
-- return type, so CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.workspace_people(team_slug text, person_status text, level_filter text, role_key text,
  after_sort text, after_key text)
RETURNS TABLE (user_id text, name text, email text, teams jsonb, company_level text, status text,
  last_sign_in timestamptz, two_step boolean, sort_key text, row_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL OR ctx.company_level IS NULL
     OR NOT (ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas))) THEN
    RAISE EXCEPTION 'Workspace people rejected' USING ERRCODE = '42501';
  END IF;
  IF (workspace_people.person_status IS NOT NULL AND workspace_people.person_status NOT IN ('active', 'invited', 'deactivated'))
     OR (workspace_people.level_filter IS NOT NULL AND workspace_people.level_filter NOT IN ('owner', 'admin', 'none'))
     OR ((workspace_people.after_sort IS NULL) <> (workspace_people.after_key IS NULL)) THEN
    RAISE EXCEPTION 'Workspace people rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH team AS (
    SELECT o.id AS team_id, o.name AS team_name, o.slug AS team_ident
      FROM app.workspace_teams wt JOIN auth.organization o ON o.id = wt.team_id
      WHERE wt.workspace_id = ctx.workspace_id
  ), chosen AS (
    SELECT tm.team_id FROM team tm WHERE tm.team_ident = workspace_people.team_slug
  ), pending AS (
    SELECT DISTINCT lower(i.email) AS invited_email, i.organization_id AS team_id, i.role AS team_role
      FROM auth.invitation i JOIN team tm ON tm.team_id = i.organization_id
      WHERE i.status = 'pending' AND i.expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM auth.member m JOIN team mt ON mt.team_id = m.organization_id
          JOIN auth."user" mu ON mu.id = m.user_id WHERE lower(mu.email) = lower(i.email))
  ), listed AS (
    SELECT u.id AS person_id, u.name AS person_name, u.email AS person_email,
      (SELECT jsonb_agg(jsonb_build_object('team', tm.team_name, 'teamRole', m.role, 'configuredRole',
          (SELECT coalesce(cv.body->>'name', dv.body->>'name') FROM app.member_roles r
             JOIN app.config_objects co ON co.id = r.role_object_id AND co.workspace_id = ctx.workspace_id
             LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
             LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
             WHERE r.team_id = m.organization_id AND r.user_id = m.user_id))
          ORDER BY tm.team_name, tm.team_ident)
        FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id) AS person_teams,
      (SELECT a.level FROM app.workspace_admins a
        WHERE a.workspace_id = ctx.workspace_id AND a.user_id = u.id AND a.suspended_at IS NULL) AS person_level,
      CASE WHEN EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = ctx.workspace_id
          AND d.user_id = u.id AND d.deactivated_at IS NOT NULL) THEN 'deactivated' ELSE 'active' END::text AS person_state,
      (SELECT max(s.created_at) FROM auth.session s WHERE s.user_id = u.id) AS person_sign_in,
      coalesce(u.two_factor_enabled, false) AS person_two_step,
      lower(u.name) AS person_sort, u.id AS person_row
    FROM auth."user" u
    WHERE EXISTS (SELECT 1 FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id)
      AND (workspace_people.team_slug IS NULL OR EXISTS (SELECT 1 FROM auth.member m
        JOIN chosen ch ON ch.team_id = m.organization_id WHERE m.user_id = u.id))
      AND (workspace_people.role_key IS NULL OR EXISTS (SELECT 1 FROM app.member_roles r
        JOIN team tm ON tm.team_id = r.team_id
        JOIN app.config_objects co ON co.id = r.role_object_id
        WHERE r.user_id = u.id AND co.workspace_id = ctx.workspace_id AND co.type = 'role'
          AND co.key = workspace_people.role_key
          AND (workspace_people.team_slug IS NULL OR r.team_id IN (SELECT ch.team_id FROM chosen ch))))
    UNION ALL
    SELECT NULL, NULL, pd.invited_email,
      jsonb_agg(jsonb_build_object('team', tm.team_name, 'teamRole', pd.team_role, 'configuredRole', NULL)
        ORDER BY tm.team_name, tm.team_ident, pd.team_role),
      NULL, 'invited', NULL, false, pd.invited_email, 'invitation:' || pd.invited_email
    FROM pending pd JOIN team tm ON tm.team_id = pd.team_id
    WHERE workspace_people.role_key IS NULL
    GROUP BY pd.invited_email
    HAVING workspace_people.team_slug IS NULL
      OR bool_or(pd.team_id IN (SELECT ch.team_id FROM chosen ch))
  )
  SELECT l.person_id, l.person_name, l.person_email, l.person_teams, l.person_level, l.person_state,
      l.person_sign_in, l.person_two_step, l.person_sort, l.person_row
    FROM listed l
    WHERE (workspace_people.person_status IS NULL OR l.person_state = workspace_people.person_status)
      AND (workspace_people.level_filter IS NULL
        OR (workspace_people.level_filter = 'none' AND l.person_level IS NULL)
        OR l.person_level = workspace_people.level_filter)
      AND (workspace_people.after_sort IS NULL
        OR (l.person_sort, l.person_row) > (workspace_people.after_sort, workspace_people.after_key))
    ORDER BY l.person_sort, l.person_row
    LIMIT 26;
END $$;

-- As in 0046, plus whether the person is deactivated in the context's workspace, and the
-- user-account rows naming them in a team of the workspace among the events. The return type
-- changes, so the function is dropped and created again; the role template grants it to the data
-- role again.
DROP FUNCTION tenant_context.workspace_person(text);
CREATE FUNCTION tenant_context.workspace_person(target_user_id text)
RETURNS TABLE (user_id text, name text, email text, last_sign_in timestamptz, two_step boolean,
  signed_in_devices integer, teams jsonb, company_level text, company_areas text[], plan_access boolean,
  authority_suspended boolean, authority_since timestamptz, deactivated boolean, events jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.workspace_id IS NULL OR ctx.company_level IS NULL
     OR NOT (ctx.company_level = 'owner' OR (ctx.company_level = 'admin' AND 'people' = ANY(ctx.company_areas))) THEN
    RAISE EXCEPTION 'Workspace person rejected' USING ERRCODE = '42501';
  END IF;
  IF workspace_person.target_user_id IS NULL OR workspace_person.target_user_id = ''
     OR length(workspace_person.target_user_id) > 128 THEN
    RAISE EXCEPTION 'Workspace person rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH team AS (
    SELECT o.id AS team_id, o.name AS team_name, o.slug AS team_ident
      FROM app.workspace_teams wt JOIN auth.organization o ON o.id = wt.team_id
      WHERE wt.workspace_id = ctx.workspace_id
  ), event AS (
    SELECT act.id AS event_id, act.created_at AS event_at, act.action AS event_action, act.actor_id AS event_actor,
      au.name AS event_actor_name,
      CASE WHEN act.kind = 'config' THEN act.metadata->>'type' END AS event_type,
      CASE WHEN act.kind = 'config' THEN act.metadata->>'key' END AS event_key,
      CASE WHEN act.kind = 'role-assignment' THEN rv.body->>'name' END AS event_role
    FROM app.activity act
    JOIN team tm ON tm.team_id = act.team_id
    LEFT JOIN auth."user" au ON au.id = act.actor_id
    LEFT JOIN app.config_versions rv ON act.kind = 'role-assignment'
      AND rv.id::text = act.metadata->>'roleVersionId' AND rv.workspace_id = ctx.workspace_id
    WHERE (act.kind = 'config' AND act.actor_id = workspace_person.target_user_id
        AND act.metadata->>'workspaceId' = ctx.workspace_id::text
        AND (act.metadata->>'type' IS DISTINCT FROM 'task-board' OR act.team_id = ctx.team_id))
      OR (act.kind = 'role-assignment' AND act.action IN ('role.assigned', 'role.cleared')
        AND act.metadata->>'affectedUserId' = workspace_person.target_user_id
        AND act.metadata->>'workspaceId' = ctx.workspace_id::text)
      OR (act.kind = 'scope' AND act.action = 'scope.home_units_changed'
        AND act.metadata->'affectedUserIds' @> jsonb_build_array(workspace_person.target_user_id)
        AND act.metadata->>'workspaceId' = ctx.workspace_id::text)
      OR (act.kind = 'workspace-authority' AND act.action = 'workspace_authority.changed'
        AND act.metadata->>'targetUserId' = workspace_person.target_user_id)
      OR (act.kind = 'account-security' AND act.action = 'two_step.reset'
        AND act.metadata->>'targetUserId' = workspace_person.target_user_id)
      OR (act.kind = 'user-account' AND act.metadata->>'targetUserId' = workspace_person.target_user_id)
    ORDER BY act.created_at DESC, act.id DESC
    LIMIT 50
  )
  SELECT u.id, u.name, u.email,
    (SELECT max(s.created_at) FROM auth.session s WHERE s.user_id = u.id),
    coalesce(u.two_factor_enabled, false),
    (SELECT count(*)::integer FROM auth.session s WHERE s.user_id = u.id AND s.expires_at > clock_timestamp()),
    (SELECT jsonb_agg(jsonb_build_object('team', tm.team_name, 'slug', tm.team_ident, 'teamRole', m.role,
        'configuredRole', (SELECT coalesce(cv.body->>'name', dv.body->>'name') FROM app.member_roles r
           JOIN app.config_objects co ON co.id = r.role_object_id AND co.workspace_id = ctx.workspace_id
           LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
           LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
           WHERE r.team_id = m.organization_id AND r.user_id = m.user_id))
        ORDER BY tm.team_name, tm.team_ident)
      FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id),
    a.level, a.areas, a.plan_access,
    CASE WHEN a.workspace_id IS NULL THEN NULL ELSE a.suspended_at IS NOT NULL END,
    a.granted_at,
    EXISTS (SELECT 1 FROM app.workspace_users d WHERE d.workspace_id = ctx.workspace_id
      AND d.user_id = u.id AND d.deactivated_at IS NOT NULL),
    coalesce((SELECT jsonb_agg(jsonb_build_object('occurredAt', ev.event_at, 'action', ev.event_action,
        'actorId', ev.event_actor, 'actorName', ev.event_actor_name, 'objectType', ev.event_type,
        'objectKey', ev.event_key, 'roleName', ev.event_role) ORDER BY ev.event_at DESC, ev.event_id DESC)
      FROM event ev), '[]'::jsonb)
  FROM auth."user" u
  LEFT JOIN app.workspace_admins a ON a.workspace_id = ctx.workspace_id AND a.user_id = u.id
  WHERE u.id = workspace_person.target_user_id
    AND EXISTS (SELECT 1 FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id WHERE m.user_id = u.id);
END $$;
REVOKE ALL ON FUNCTION tenant_context.workspace_person(text) FROM PUBLIC;

-- The code now reads and changes deactivation and calls the new helpers; startup refuses a database
-- without them.
UPDATE db_boundary.storage_schema SET version = 25;
