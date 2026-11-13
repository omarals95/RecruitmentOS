-- Groups as role grantees (ADM-14, job 103). Apply after migration 0056 (group managers), then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role SELECT, INSERT and
-- DELETE on app.group_roles and EXECUTE again on tenant_context.role_assignment_changes, whose
-- return type changes here; the identity role gets nothing. A company owner gives a company group
-- one configured role per team (app.group_roles, company owner sessions only, guarded by
-- app.guard_group_role). tenant_context.group_grants is also true for a group that gives a role or
-- is nested under one, so the existing group policies, app.guard_group_write and the manager
-- policies make such groups company owner only and closed to managers (D20). tenant_context.install
-- takes a member's direct app.member_roles row, else the one role the current groups they are in
-- give for the team, and fails closed on two (D30); a grant, or a membership or nesting change, that
-- would give a member two configured roles in one team is RQ024 with ids only. Grants and removals
-- write one ids-only group activity row each, which tenant_context.role_assignment_changes also
-- returns, and the people helpers name the role in force. No existing row is rewritten. The storage
-- schema marker goes to 35, so startup refuses a database without this migration.

-- One configured role a group gives its effective members in one team; no update path.
CREATE TABLE app.group_roles (
  group_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  team_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  role_object_id uuid NOT NULL REFERENCES app.config_objects(id),
  granted_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, team_id),
  CONSTRAINT group_roles_group_fkey FOREIGN KEY (group_id, workspace_id) REFERENCES app.groups(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX group_roles_team_idx ON app.group_roles(team_id);

-- Company owners and company admins with people read the grants; only a company owner session
-- inserts one (the roles area). A delete may target any readable row, so a refused one reaches the
-- guard below and fails with 42501 instead of matching no row. No update policy.
DO $group_roles_rls$ DECLARE command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  read_rule text := 'tenant_context.allows_workspace(workspace_id, ''read'', ''people'')';
BEGIN
  ALTER TABLE app.group_roles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app.group_roles FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON app.group_roles FROM PUBLIC;
  -- Owner-only access for the migration, the trigger functions, owner-run helpers and fixtures.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.group_roles FOR %s %s', 'group_owner_' || lower(command), command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  EXECUTE format('CREATE POLICY context_read ON app.group_roles FOR SELECT USING (%s)', read_rule);
  EXECUTE 'CREATE POLICY context_insert ON app.group_roles FOR INSERT WITH CHECK (tenant_context.allows_workspace(workspace_id, ''write'', ''roles''))';
  EXECUTE format('CREATE POLICY context_delete ON app.group_roles FOR DELETE USING (%s)', read_rule);
END $group_roles_rls$;

-- Every grant write. As app.guard_group_write, the owner's own SQL is told apart by having no context
-- row of this backend and transaction, and passes. Any other write needs an unexpired session
-- context of the row's workspace whose company level is owner (42501 otherwise: expired contexts,
-- tokens, company admins, team-only owners and admins, managers, other workspaces). The workspace row
-- lock then serialises grants with membership and nesting changes. A grant is given and removed,
-- never changed (42501). An insert needs a group that is not archived (RQ023), a team of the row's
-- workspace and a published, unarchived role of that workspace whose membership is admin, recruiter
-- or viewer (42501, the app.guard_member_role rule); granted_by and granted_at come from the context.
CREATE FUNCTION app.guard_group_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
  role_body jsonb;
BEGIN
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
  IF ctx.expires_at <= clock_timestamp() OR ctx.auth_type IS DISTINCT FROM 'session'
     OR ctx.workspace_id IS DISTINCT FROM row_workspace OR ctx.company_level IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only a company owner can give a group a role' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = row_workspace FOR NO KEY UPDATE;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A group role is given and removed, never changed' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM app.groups g WHERE g.id = NEW.group_id AND g.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'An archived group gives no new role' USING ERRCODE = 'RQ023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.workspace_teams t WHERE t.team_id = NEW.team_id AND t.workspace_id = row_workspace) THEN
    RAISE EXCEPTION 'Give a role in a team of this company' USING ERRCODE = '42501';
  END IF;
  SELECT v.body INTO role_body FROM app.config_objects o JOIN app.config_versions v
      ON v.id = o.current_version_id AND v.object_id = o.id AND v.workspace_id = o.workspace_id AND v.state = 'published'
    WHERE o.id = NEW.role_object_id AND o.workspace_id = row_workspace AND o.type = 'role' AND o.archived_at IS NULL;
  IF NOT FOUND OR jsonb_typeof(role_body->'membership') IS DISTINCT FROM 'string'
     OR role_body->>'membership' NOT IN ('admin', 'recruiter', 'viewer') THEN
    RAISE EXCEPTION 'Give a published role of this company' USING ERRCODE = '42501';
  END IF;
  NEW.granted_by := ctx.actor_id;
  NEW.granted_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_group_role() FROM PUBLIC;
CREATE TRIGGER group_roles_guard BEFORE INSERT OR UPDATE OR DELETE ON app.group_roles
  FOR EACH ROW EXECUTE FUNCTION app.guard_group_role();

-- The two-roles check (D30), for every writer, the owner's own SQL included. Of the given user and
-- team pairs, a conflict is a member of the team who is not a team owner, has no app.member_roles row
-- there, and is an effective member of current groups that give two or more different roles in that
-- team. The first team with a conflict, by id, is RQ024 with a DETAIL of ids only: the team, the
-- first 20 user ids in order and how many people it affects.
CREATE FUNCTION app.refuse_group_role_conflicts(user_ids text[], team_ids text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  conflict_team text;
  conflict_users text[];
  conflict_count integer;
BEGIN
  SELECT x.team_id, (array_agg(x.user_id ORDER BY x.user_id))[1:20], count(*)::integer
    INTO conflict_team, conflict_users, conflict_count
    FROM (SELECT DISTINCT c.user_id, c.team_id FROM unnest(user_ids, team_ids) AS c(user_id, team_id)
      WHERE EXISTS (SELECT 1 FROM auth.member m
          WHERE m.organization_id = c.team_id AND m.user_id = c.user_id AND m.role <> 'owner')
        AND NOT EXISTS (SELECT 1 FROM app.member_roles r WHERE r.team_id = c.team_id AND r.user_id = c.user_id)
        AND (SELECT count(DISTINCT gr.role_object_id) FROM app.group_effective_members e
            JOIN app.groups g ON g.id = e.group_id AND g.archived_at IS NULL
            JOIN app.group_roles gr ON gr.group_id = g.id AND gr.team_id = c.team_id
            WHERE e.user_id = c.user_id) > 1) x
    GROUP BY x.team_id ORDER BY x.team_id LIMIT 1;
  IF conflict_team IS NOT NULL THEN
    RAISE EXCEPTION 'A member would hold two configured roles in one team' USING ERRCODE = 'RQ024',
      DETAIL = jsonb_build_object('teamId', conflict_team, 'userIds', to_jsonb(conflict_users),
        'count', conflict_count)::text;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.refuse_group_role_conflicts(text[], text[]) FROM PUBLIC;

-- After a grant: the effective members of its group in its team, under the workspace row lock.
CREATE FUNCTION app.check_group_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  PERFORM app.refuse_group_role_conflicts(
    ARRAY(SELECT e.user_id FROM app.group_effective_members e WHERE e.group_id = NEW.group_id ORDER BY e.user_id),
    ARRAY(SELECT NEW.team_id FROM app.group_effective_members e WHERE e.group_id = NEW.group_id ORDER BY e.user_id));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_group_role() FROM PUBLIC;
CREATE TRIGGER group_roles_check AFTER INSERT ON app.group_roles
  FOR EACH ROW EXECUTE FUNCTION app.check_group_role();

-- As in 0052, plus the two-roles check after the rebuild of an insert or update: the users whose
-- effective rows were rebuilt, in each team a rebuilt group gives a role in. Only a rebuilt group's
-- new effective member can hold a new role, so no other pair can conflict anew. A delete never
-- creates a conflict. CREATE OR REPLACE keeps the trigger.
CREATE OR REPLACE FUNCTION app.maintain_group_members() RETURNS trigger
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
  IF TG_OP <> 'DELETE' THEN
    PERFORM app.refuse_group_role_conflicts(array_agg(p.user_id ORDER BY p.user_id, p.team_id),
        array_agg(p.team_id ORDER BY p.user_id, p.team_id))
      FROM (SELECT DISTINCT e.user_id, r.team_id FROM app.group_effective_members e
        JOIN app.group_roles r ON r.group_id = e.group_id WHERE e.group_id = ANY(affected)) p;
  END IF;
  RETURN NULL;
END $$;

-- True when the group, or any group it is nested in at any depth, archived or not, is an approval
-- group or gives a role (app.group_roles). Otherwise as in 0052: only groups of the current
-- context's workspace count, and an unknown group, a group of another workspace or no context is
-- false. Reveals that boolean only. CREATE OR REPLACE keeps its grant.
CREATE OR REPLACE FUNCTION tenant_context.group_grants(group_id uuid) RETURNS boolean
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
  SELECT EXISTS (SELECT 1 FROM up JOIN app.groups g ON g.id = up.id
    WHERE g.approval OR EXISTS (SELECT 1 FROM app.group_roles r WHERE r.group_id = g.id))
$$;

-- As in 0047, changed only where the role is chosen: with no app.member_roles row, a member who is
-- not a team owner holds the one configured role the current groups of the context's workspace they
-- are an effective member of give for the verified team (app.group_roles), through the same role
-- path, so a group role narrows the asserted scopes exactly as a direct one and never adds one. Two or
-- more different group roles store no scopes, no role version and no record scope, as an unusable
-- role does (fail closed). Every other check, output and statement is unchanged.
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
  granted uuid[] := '{}';
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
  -- A direct role wins; else the roles the actor's current groups give in this team (D30).
  IF NOT FOUND AND member_role <> 'owner' THEN
    granted := ARRAY(SELECT DISTINCT gr.role_object_id FROM app.group_roles gr
      JOIN app.group_effective_members e ON e.group_id = gr.group_id AND e.user_id = claim->>'actor'
      JOIN app.groups g ON g.id = gr.group_id AND g.workspace_id = company AND g.archived_at IS NULL
      WHERE gr.team_id = claim->>'team');
    IF cardinality(granted) = 1 THEN
      assigned := granted[1];
    END IF;
  END IF;
  IF cardinality(granted) > 1 THEN
    role_version := NULL;
    stored := '{}';
    record_scope_held := NULL;
  ELSIF assigned IS NULL THEN
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

-- As in 0056, plus one group.role_granted or group.role_removed row per insert or delete of a grant,
-- ids only: the workspace, group, team, role object and the role's current version at that moment,
-- as app.audit_member_role records it.
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
  ELSIF TG_TABLE_NAME = 'group_roles' THEN
    actions := ARRAY[CASE TG_OP WHEN 'INSERT' THEN 'group.role_granted' ELSE 'group.role_removed' END];
    metadata := jsonb_build_object('workspaceId', changed_row->'workspace_id', 'groupId', changed_row->'group_id',
      'teamId', changed_row->'team_id', 'roleObjectId', changed_row->'role_object_id',
      'roleVersionId', (SELECT o.current_version_id FROM app.config_objects o
        WHERE o.id = (changed_row->>'role_object_id')::uuid AND o.workspace_id = ctx.workspace_id));
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
        WHEN 'group.role_granted' THEN 'Gave a group a role'
        WHEN 'group.role_removed' THEN 'Removed a role from a group'
        ELSE 'Removed a group manager' END,
      metadata);
  END LOOP;
  RETURN NULL;
END $$;

-- As in 0056, plus group.role_granted and group.role_removed in the group branch.
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
        'group.child_replaced', 'group.manager_added', 'group.manager_removed', 'group.role_granted', 'group.role_removed')
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
CREATE TRIGGER group_roles_audit AFTER INSERT OR DELETE ON app.group_roles
  FOR EACH ROW EXECUTE FUNCTION app.audit_group_change();

-- As in 0035, plus the group.role_granted and group.role_removed rows of the workspace, which name
-- no affected user, and a last column group_name: the current name of the group such a row names,
-- null for every other row. Its checks, order and paging are unchanged. The return type changes, so
-- the function is dropped and created again; the role template grants it to the data role again.
DROP FUNCTION tenant_context.role_assignment_changes(timestamptz, integer);
CREATE FUNCTION tenant_context.role_assignment_changes(before timestamptz, page_size integer)
RETURNS TABLE (occurred_at timestamptz, action text, affected_user_id text, role_name text, actor_name text,
  group_name text)
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
  RETURN QUERY SELECT a.created_at, a.action, a.metadata->>'affectedUserId', v.body->>'name', u.name, g.name
    FROM app.activity a
    JOIN app.workspace_teams t ON t.team_id = a.team_id
    LEFT JOIN app.config_versions v ON v.id::text = a.metadata->>'roleVersionId' AND v.workspace_id = ctx.workspace_id
    LEFT JOIN auth."user" u ON u.id = a.actor_id
    LEFT JOIN app.groups g ON a.kind = 'group' AND g.id::text = a.metadata->>'groupId' AND g.workspace_id = ctx.workspace_id
    WHERE ((a.kind = 'role-assignment' AND a.action IN ('role.assigned', 'role.cleared'))
        OR (a.kind = 'group' AND a.action IN ('group.role_granted', 'group.role_removed')))
      AND t.workspace_id = ctx.workspace_id
      AND a.metadata->>'workspaceId' = ctx.workspace_id::text
      AND (role_assignment_changes.before IS NULL OR a.created_at < role_assignment_changes.before)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT role_assignment_changes.page_size;
END $$;
REVOKE ALL ON FUNCTION tenant_context.role_assignment_changes(timestamptz, integer) FROM PUBLIC;

-- As in 0047, with each team entry's configuredRole the role in force: the direct app.member_roles
-- role's name, else the name of the one role the person's current groups give in that team, else
-- null; roleGroup the name of the first such group by name (null for a direct role or none); and
-- roleConflict true when there is no direct role and the groups give two or more different roles.
-- Team owners hold no group role. The role_key filter matches the role in force. Same signature and
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
          CASE WHEN direct.held THEN direct.role_name WHEN via.roles = 1 THEN via.role_name END,
          'roleGroup', CASE WHEN direct.held IS NULL AND via.roles = 1 THEN via.group_name END,
          'roleConflict', direct.held IS NULL AND via.roles > 1)
          ORDER BY tm.team_name, tm.team_ident)
        FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id
        LEFT JOIN LATERAL (SELECT true AS held, coalesce(cv.body->>'name', dv.body->>'name') AS role_name
          FROM app.member_roles r
          JOIN app.config_objects co ON co.id = r.role_object_id AND co.workspace_id = ctx.workspace_id
          LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
          LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
          WHERE r.team_id = m.organization_id AND r.user_id = m.user_id) direct ON true
        LEFT JOIN LATERAL (SELECT count(DISTINCT gr.role_object_id) AS roles,
            (array_agg(coalesce(cv.body->>'name', dv.body->>'name') ORDER BY lower(g.name), g.id))[1] AS role_name,
            (array_agg(g.name ORDER BY lower(g.name), g.id))[1] AS group_name
          FROM app.group_roles gr
          JOIN app.groups g ON g.id = gr.group_id AND g.workspace_id = ctx.workspace_id AND g.archived_at IS NULL
          JOIN app.group_effective_members e ON e.group_id = g.id AND e.user_id = m.user_id
          JOIN app.config_objects co ON co.id = gr.role_object_id AND co.workspace_id = ctx.workspace_id
          LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
          LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
          WHERE gr.team_id = m.organization_id AND m.role <> 'owner') via ON true
        WHERE m.user_id = u.id) AS person_teams,
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
          AND (workspace_people.team_slug IS NULL OR r.team_id IN (SELECT ch.team_id FROM chosen ch)))
        -- Or the one role the person's current groups give in a team where they have no direct role.
        OR EXISTS (SELECT 1 FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id
          WHERE m.user_id = u.id AND m.role <> 'owner'
            AND (workspace_people.team_slug IS NULL OR m.organization_id IN (SELECT ch.team_id FROM chosen ch))
            AND NOT EXISTS (SELECT 1 FROM app.member_roles r WHERE r.team_id = m.organization_id AND r.user_id = m.user_id)
            AND (SELECT count(DISTINCT gr.role_object_id) = 1 AND bool_and(co.key = workspace_people.role_key)
              FROM app.group_roles gr
              JOIN app.groups g ON g.id = gr.group_id AND g.workspace_id = ctx.workspace_id AND g.archived_at IS NULL
              JOIN app.group_effective_members e ON e.group_id = g.id AND e.user_id = m.user_id
              JOIN app.config_objects co ON co.id = gr.role_object_id AND co.workspace_id = ctx.workspace_id AND co.type = 'role'
              WHERE gr.team_id = m.organization_id)))
    UNION ALL
    SELECT NULL, NULL, pd.invited_email,
      jsonb_agg(jsonb_build_object('team', tm.team_name, 'teamRole', pd.team_role, 'configuredRole', NULL,
        'roleGroup', NULL, 'roleConflict', false)
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

-- As in 0047, with the same team entry changes as workspace_people above. Same signature and return
-- type, so CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION tenant_context.workspace_person(target_user_id text)
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
        'configuredRole',
          CASE WHEN direct.held THEN direct.role_name WHEN via.roles = 1 THEN via.role_name END,
          'roleGroup', CASE WHEN direct.held IS NULL AND via.roles = 1 THEN via.group_name END,
          'roleConflict', direct.held IS NULL AND via.roles > 1)
        ORDER BY tm.team_name, tm.team_ident)
      FROM auth.member m JOIN team tm ON tm.team_id = m.organization_id
        LEFT JOIN LATERAL (SELECT true AS held, coalesce(cv.body->>'name', dv.body->>'name') AS role_name
          FROM app.member_roles r
          JOIN app.config_objects co ON co.id = r.role_object_id AND co.workspace_id = ctx.workspace_id
          LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
          LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
          WHERE r.team_id = m.organization_id AND r.user_id = m.user_id) direct ON true
        LEFT JOIN LATERAL (SELECT count(DISTINCT gr.role_object_id) AS roles,
            (array_agg(coalesce(cv.body->>'name', dv.body->>'name') ORDER BY lower(g.name), g.id))[1] AS role_name,
            (array_agg(g.name ORDER BY lower(g.name), g.id))[1] AS group_name
          FROM app.group_roles gr
          JOIN app.groups g ON g.id = gr.group_id AND g.workspace_id = ctx.workspace_id AND g.archived_at IS NULL
          JOIN app.group_effective_members e ON e.group_id = g.id AND e.user_id = m.user_id
          JOIN app.config_objects co ON co.id = gr.role_object_id AND co.workspace_id = ctx.workspace_id
          LEFT JOIN app.config_versions cv ON cv.id = co.current_version_id
          LEFT JOIN app.config_versions dv ON dv.id = co.draft_version_id
          WHERE gr.team_id = m.organization_id AND m.role <> 'owner') via ON true
      WHERE m.user_id = u.id),
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

-- The code now gives groups roles and reads the role in force; startup refuses a database without
-- this migration.
UPDATE db_boundary.storage_schema SET version = 35;
