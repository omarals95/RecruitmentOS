-- User account anonymisation (ADM-10, job 085). Apply after 0050_job_title_usage.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.anonymise_user and nothing on app.user_anonymisations; the identity role gets
-- nothing. A company owner session permanently anonymises one person of the derived workspace through
-- the owner-run helper: their team memberships, sessions, password credentials, API tokens and MCP
-- OAuth grants, two-step secret and backup codes, trusted devices and challenges, configured roles,
-- record assignments, company authority row and invitations to their email go. The auth."user" row
-- stays, because records, uploads, activity and teams reference it, but its name and email become a
-- placeholder. Every activity row about the person is redacted to type, time and actor, pointing to a
-- tombstone that holds ids only; rows the person acted in keep their actor id, which now reads as the
-- placeholder. No record, upload, candidate state, employee, position, unit, configuration or
-- app.workspace_users row is read or changed. app.prevent_activity_mutation() and the app.activity
-- insert policy are replaced. The storage schema marker goes to 29, so startup refuses a database
-- without this migration.

-- Only the id, workspace, user id, anonymising owner, time and source; never a name or email.
-- Owner-only: no runtime role reads or writes it.
CREATE TABLE app.user_anonymisations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  user_id text NOT NULL REFERENCES auth."user"(id),
  anonymised_by text NOT NULL REFERENCES auth."user"(id),
  anonymised_at timestamptz NOT NULL,
  erasure_source text NOT NULL CHECK (erasure_source IN ('app', 'script')),
  UNIQUE (workspace_id, user_id)
);
ALTER TABLE app.user_anonymisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_anonymisations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.user_anonymisations FROM PUBLIC;

ALTER TABLE app.activity ADD COLUMN user_anonymisation_id uuid,
  ADD CONSTRAINT activity_user_anonymisation_fkey FOREIGN KEY (user_anonymisation_id) REFERENCES app.user_anonymisations(id);
CREATE INDEX activity_user_anonymisation_idx ON app.activity(user_anonymisation_id) WHERE user_anonymisation_id IS NOT NULL;

-- As in 0036, plus the user anonymisation helper's redaction: it sets user_anonymisation_id once and
-- replaces summary and metadata. Id, team, actor, token, action, kind, time, record and both other
-- tombstones never change, and the two earlier redactions leave user_anonymisation_id as it was.
CREATE OR REPLACE FUNCTION app.prevent_activity_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND OLD.erasure_id IS NULL AND NEW.erasure_id IS NOT NULL AND NEW.record_id IS NULL
     AND (NEW.id, NEW.team_id, NEW.actor_id, NEW.actor_type, NEW.token_id, NEW.action, NEW.kind, NEW.created_at, NEW.user_anonymisation_id)
       IS NOT DISTINCT FROM (OLD.id, OLD.team_id, OLD.actor_id, OLD.actor_type, OLD.token_id, OLD.action, OLD.kind, OLD.created_at, OLD.user_anonymisation_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND OLD.employee_erasure_id IS NULL AND NEW.employee_erasure_id IS NOT NULL
     AND (NEW.id, NEW.team_id, NEW.actor_id, NEW.actor_type, NEW.token_id, NEW.action, NEW.kind, NEW.created_at, NEW.record_id, NEW.erasure_id, NEW.user_anonymisation_id)
       IS NOT DISTINCT FROM (OLD.id, OLD.team_id, OLD.actor_id, OLD.actor_type, OLD.token_id, OLD.action, OLD.kind, OLD.created_at, OLD.record_id, OLD.erasure_id, OLD.user_anonymisation_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND OLD.user_anonymisation_id IS NULL AND NEW.user_anonymisation_id IS NOT NULL
     AND (NEW.id, NEW.team_id, NEW.actor_id, NEW.actor_type, NEW.token_id, NEW.action, NEW.kind, NEW.created_at, NEW.record_id, NEW.erasure_id, NEW.employee_erasure_id)
       IS NOT DISTINCT FROM (OLD.id, OLD.team_id, OLD.actor_id, OLD.actor_type, OLD.token_id, OLD.action, OLD.kind, OLD.created_at, OLD.record_id, OLD.erasure_id, OLD.employee_erasure_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Activity history is append-only';
END $$;

-- As in 0048, plus: every branch but the new one needs user_anonymisation_id null, and only the
-- helper below inserts the user-anonymisation row that names a user anonymisation tombstone.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND user_anonymisation_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment', 'team-archive', 'user-account', 'salary-brackets', 'user-anonymisation') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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

-- Owner-only access for the helper below: it reads and writes the tombstones. The owner-only
-- policies of 0021 (activity SELECT and UPDATE), 0028 (company authority), 0035 (configured roles),
-- 0037 (record assignments) and 0047 (deactivation) cover the rest.
DO $user_anonymisation_policies$ DECLARE command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
  FOREACH command IN ARRAY ARRAY['SELECT', 'INSERT'] LOOP
    EXECUTE format('CREATE POLICY %I ON app.user_anonymisations FOR %s %s', 'anonymisation_owner_' || lower(command), command,
      CASE command WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only) ELSE format('USING (%s)', owner_only) END);
  END LOOP;
END $user_anonymisation_policies$;

-- Session contexts whose derived company level is owner only, in a read committed transaction
-- (42501 otherwise: token, OAuth and MCP contexts, company admins with any area, and team owners or
-- admins without company authority); a null, empty or over-long user id or another source is 22023.
-- Under the workspace row lock the caller must still hold an unsuspended company owner row and not be
-- deactivated (42501), then the person's user row is locked. A person anonymised in this workspace
-- before gets the earlier result and nothing is written; one in no team of the workspace, or unknown,
-- gets null. Then, in order: the trimmed typed name must equal the trimmed name, case included
-- (RQ003); the person may be in no team outside the workspace (RQ020); the person may not be the
-- last owner of a team of the workspace, archived or not (RQ019), nor the last unsuspended,
-- active company owner (RQ005); and the person may not be the caller (RQ018). Returns the tombstone,
-- time and counts only; never a name or email.
CREATE FUNCTION tenant_context.anonymise_user(user_id text, confirm_name text, erasure_source text) RETURNS jsonb
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
REVOKE ALL ON FUNCTION tenant_context.anonymise_user(text, text, text) FROM PUBLIC;

-- The code now depends on the tombstone table, the activity column and the helper; startup refuses a
-- database without them.
UPDATE db_boundary.storage_schema SET version = 29;
