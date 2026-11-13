-- Salary brackets under Plan & pay access (ADM-25, job 083). Apply after 0047_user_deactivation.sql,
-- then rerun infrastructure/postgres-split-runtime-roles.sql, which grants the data role SELECT,
-- INSERT and UPDATE on the two new tables and EXECUTE on the three new helpers below; the identity
-- role gets nothing. Versioned salary brackets per job grade, in AED fils (D23: no currency column),
-- are company rows under forced row-level security. Every runtime policy calls the new
-- tenant_context.allows_plan, which reads only the context row: a session of the row's workspace
-- holding the Plan & pay access grant and plans:read to read, plans:write to write. Writes also
-- need a company owner or a company admin with organisation (allows_workspace). Published versions
-- and their brackets never change; only the owner-run tenant_context.publish_bracket_version
-- publishes, as the next number, and retires nothing. app.records gains a nullable
-- pay_bracket_version_id, set only on offer creates through the id-only
-- tenant_context.published_bracket_version. No existing row is rewritten: every record keeps a null
-- pin. The storage schema marker goes to 26, so startup refuses a database without this migration.

-- No number while a draft; AED only, so no currency column.
CREATE TABLE app.salary_bracket_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  number integer CHECK (number > 0),
  pay_period text NOT NULL DEFAULT 'monthly' CHECK (pay_period IN ('monthly','annual')),
  covers text NOT NULL DEFAULT 'basic' CHECK (covers IN ('basic','basic-housing-transport','total-cash')),
  effective_from date NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
  created_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  published_at timestamptz,
  CONSTRAINT salary_bracket_versions_draft_number_check CHECK ((number IS NULL) = (state = 'draft')),
  CONSTRAINT salary_bracket_versions_number_unique UNIQUE (workspace_id, number),
  UNIQUE (id, workspace_id)
);
-- One row per grade code of the version, in fils (AED 1,000,000,000 at most, the offer ceiling).
CREATE TABLE app.salary_brackets (
  version_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  grade_code text NOT NULL CHECK (grade_code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  minimum_fils bigint NOT NULL,
  midpoint_fils bigint NOT NULL,
  maximum_fils bigint NOT NULL,
  CONSTRAINT salary_brackets_order_check CHECK (0 < minimum_fils AND minimum_fils <= midpoint_fils
    AND midpoint_fils <= maximum_fils AND maximum_fils <= 100000000000),
  PRIMARY KEY (version_id, grade_code),
  FOREIGN KEY (version_id, workspace_id) REFERENCES app.salary_bracket_versions(id, workspace_id) ON DELETE CASCADE
);

-- Policy predicate for plan figures (architecture 9.2): the current, unexpired session context of
-- the row's workspace holds the Plan & pay access grant and, for read, plans:read or, for write,
-- plans:write. It reads the context row only: no team role, company level, area, group or approval
-- membership gives access. Tokens never hold the plan scopes; a token context is refused anyway.
CREATE FUNCTION tenant_context.allows_plan(row_workspace uuid, access text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session'
      AND c.workspace_id = row_workspace AND c.plan_access
      AND CASE access WHEN 'read' THEN 'plans:read' = ANY(c.scopes)
        WHEN 'write' THEN 'plans:write' = ANY(c.scopes)
        ELSE false END)
$$;
REVOKE ALL ON FUNCTION tenant_context.allows_plan(uuid, text) FROM PUBLIC;

DO $bracket_rls$ DECLARE tbl text; command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  writer text := 'tenant_context.allows_plan(workspace_id, ''write'') AND tenant_context.allows_workspace(workspace_id, ''write'', ''organisation'')';
BEGIN
 FOREACH tbl IN ARRAY ARRAY['salary_bracket_versions','salary_brackets'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', tbl);
  -- Owner-only access for the migration, the helpers and the owner's fixture cleanup, as the
  -- config_owner_* policies of 0030.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'bracket_owner_' || lower(command), tbl, command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  -- Runtime contexts: the grant and the plan scope; writers also need organisation. No delete.
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (tenant_context.allows_plan(workspace_id, ''read''))', tbl);
  EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', tbl, writer);
  EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, writer, writer);
 END LOOP;
END $bracket_rls$;

-- Immutability, in the pattern of app.guard_config_version: a security invoker function, so
-- current_user is the caller, a runtime role or the owner inside an owner-run helper. A runtime role
-- creates only drafts and edits only a draft's pay period, coverage and effective date; only the
-- owner moves a draft to published; nobody changes a published or retired version, or inserts or
-- changes a bracket of a version that is not a draft (a version the caller cannot read counts as
-- not a draft). Only the owner deletes what is not a draft (fixture cleanup).
CREATE FUNCTION app.guard_salary_brackets() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner boolean := current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
  old_state text;
  new_state text;
BEGIN
  IF TG_TABLE_NAME = 'salary_brackets' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT v.state INTO old_state FROM app.salary_bracket_versions v WHERE v.id = OLD.version_id;
    END IF;
    IF TG_OP = 'DELETE' THEN
      IF old_state IS DISTINCT FROM 'draft' AND NOT owner THEN
        RAISE EXCEPTION 'Published salary brackets cannot be deleted' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    SELECT v.state INTO new_state FROM app.salary_bracket_versions v WHERE v.id = NEW.version_id;
    IF new_state IS DISTINCT FROM 'draft' OR (TG_OP = 'UPDATE' AND old_state IS DISTINCT FROM 'draft') THEN
      RAISE EXCEPTION 'Published salary brackets are immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' AND NOT owner THEN
      RAISE EXCEPTION 'Published salary bracket versions cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT owner AND (NEW.state <> 'draft' OR NEW.number IS NOT NULL OR NEW.published_by IS NOT NULL
        OR NEW.published_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Only a draft can be created' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'draft' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Published salary bracket versions are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (owner AND OLD.state = 'draft' AND NEW.state = 'published') THEN
    RAISE EXCEPTION 'Salary bracket state change rejected' USING ERRCODE = '42501';
  END IF;
  IF NOT owner AND (NEW.id, NEW.workspace_id, NEW.number, NEW.state, NEW.created_by, NEW.created_at, NEW.published_by, NEW.published_at)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.number, OLD.state, OLD.created_by, OLD.created_at, OLD.published_by, OLD.published_at) THEN
    RAISE EXCEPTION 'Only a draft''s pay period, coverage and effective date can be edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_salary_brackets() FROM PUBLIC;
CREATE TRIGGER salary_bracket_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON app.salary_bracket_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_salary_brackets();
CREATE TRIGGER salary_brackets_guard BEFORE INSERT OR UPDATE OR DELETE ON app.salary_brackets
  FOR EACH ROW EXECUTE FUNCTION app.guard_salary_brackets();
-- created_by comes from the verified context, never from the row, as for configuration versions.
CREATE TRIGGER salary_bracket_versions_stamp BEFORE INSERT ON app.salary_bracket_versions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_config_actor();

-- A session context of the version's workspace that may write brackets (allows_plan and
-- allows_workspace with organisation): 42501 otherwise; RQ007 unless the version is a draft with at
-- least one bracket. Under the workspace row lock it numbers the version after the workspace's
-- highest, publishes it, retires nothing and writes one salary-brackets activity row to the
-- acting team, whose metadata holds ids and the number only, never a figure.
CREATE FUNCTION tenant_context.publish_bracket_version(version_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  ver app.salary_bracket_versions%ROWTYPE;
  next_number integer;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF FOUND THEN
    SELECT * INTO ver FROM app.salary_bracket_versions v
      WHERE v.id = publish_bracket_version.version_id AND v.workspace_id = ctx.workspace_id;
  END IF;
  IF ver.id IS NULL OR NOT tenant_context.allows_plan(ver.workspace_id, 'write')
     OR NOT tenant_context.allows_workspace(ver.workspace_id, 'write', 'organisation') THEN
    RAISE EXCEPTION 'Salary bracket publish rejected' USING ERRCODE = '42501';
  END IF;
  -- One publish at a time per workspace; a concurrent publish of this version is seen after the lock.
  PERFORM 1 FROM app.workspaces w WHERE w.id = ver.workspace_id FOR NO KEY UPDATE;
  SELECT * INTO ver FROM app.salary_bracket_versions v WHERE v.id = publish_bracket_version.version_id FOR UPDATE;
  IF ver.state <> 'draft' OR NOT EXISTS (SELECT 1 FROM app.salary_brackets b WHERE b.version_id = ver.id) THEN
    RAISE EXCEPTION 'Only a draft with brackets can be published' USING ERRCODE = 'RQ007';
  END IF;
  SELECT coalesce(max(v.number), 0) + 1 INTO next_number FROM app.salary_bracket_versions v
    WHERE v.workspace_id = ver.workspace_id;
  UPDATE app.salary_bracket_versions v SET state = 'published', number = next_number, published_by = ctx.actor_id,
    published_at = clock_timestamp() WHERE v.id = ver.id;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'salary_brackets.published', 'salary-brackets',
    'Published a salary bracket version',
    jsonb_build_object('workspaceId', ver.workspace_id, 'versionId', ver.id, 'number', next_number));
  RETURN next_number;
END $$;
REVOKE ALL ON FUNCTION tenant_context.publish_bracket_version(uuid) FROM PUBLIC;

-- Any current context, session or token (42501 without one): the id of the highest-numbered
-- published version of the context's workspace, or null. An id only, never a figure, pay period or
-- coverage, so an offer is pinned by a caller who cannot read brackets.
CREATE FUNCTION tenant_context.published_bracket_version() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  company uuid;
BEGIN
  SELECT c.workspace_id INTO company FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salary bracket version lookup rejected' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT v.id FROM app.salary_bracket_versions v
    WHERE v.workspace_id = company AND v.state = 'published' ORDER BY v.number DESC LIMIT 1);
END $$;
REVOKE ALL ON FUNCTION tenant_context.published_bracket_version() FROM PUBLIC;

-- As in 0047, plus: salary-brackets rows come only from the owner (the publish helper above).
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment', 'team-archive', 'user-account', 'salary-brackets') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND employee_erasure_id IS NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'employee-erasure' AND action = 'employee.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The bracket version an offer was made under (ORG-107 compares against it). Nullable, no default,
-- no constraint: every existing record keeps a null pin.
ALTER TABLE app.records ADD COLUMN pay_bracket_version_id uuid;

-- The code now reads and writes brackets and pins offers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 26;
