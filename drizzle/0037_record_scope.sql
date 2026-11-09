-- Record scope in the service: columns, assignments and home units (R2a-18, job 060). Apply after
-- 0036_employee_erasure.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which grants
-- the data role SELECT on app.record_assignments and EXECUTE on tenant_context.add_assignment and
-- tenant_context.remove_assignment, and neither runtime role any write on app.record_assignments.
-- Records gain an org unit and the vacancy and application they belong to, kept by an owner-owned
-- trigger; assignments put records in a member's scope and are written only through the two helpers;
-- tenant_context.install returns the member's record scope and home units in its existing round
-- trip; roles limited to a unit or to assigned records are no longer refused. No existing record row
-- is rewritten: older rows keep null scope columns until their next write or until their vacancy
-- gets a unit. Row-level security by record scope is R2a-19. The storage schema marker goes to 16,
-- so startup refuses a database without this migration.

-- The vacancy's unit, copied down its pipeline, and the vacancy and application each row belongs to
-- (architecture 3.5). The partial index serves the candidate rule's probe of a candidate's
-- applications.
ALTER TABLE app.records ADD COLUMN org_unit_id uuid, ADD COLUMN scope_vacancy_id uuid,
  ADD COLUMN scope_application_id uuid;
CREATE INDEX records_application_candidate_idx ON app.records(team_id, candidate_id) WHERE kind = 'application';

-- Before insert and update: fills the three scope columns from the row's own parents in its own
-- team, always overwriting what the statement supplied. A vacancy keeps the unit written, which must
-- be a current, non-archived unit of the team's workspace when it is set or changed (RQ012
-- otherwise); applications take it from their vacancy, interviews, offers and onboarding from their
-- application, checklist items from their onboarding, and comments from a vacancy or pipeline
-- parent. Every other kind holds nulls. After a vacancy's unit changes, the same function updates
-- every pipeline row and comment below it through the reference chain, so rows written before 0037
-- are reached too; their before trigger recomputes the columns, and nothing else on them changes.
CREATE FUNCTION app.maintain_record_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  parent app.records%ROWTYPE;
  applications uuid[];
  children uuid[];
  checklist uuid[];
BEGIN
  IF TG_WHEN = 'AFTER' THEN
    applications := ARRAY(SELECT r.id FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.kind = 'application' AND r.vacancy_id = NEW.id);
    UPDATE app.records r SET org_unit_id = NEW.org_unit_id
      WHERE r.team_id = NEW.team_id AND r.id = ANY(applications);
    children := ARRAY(SELECT r.id FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.kind IN ('interview', 'offer', 'onboarding')
        AND r.application_id = ANY(applications));
    UPDATE app.records r SET org_unit_id = NEW.org_unit_id
      WHERE r.team_id = NEW.team_id AND r.id = ANY(children);
    checklist := ARRAY(SELECT r.id FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.kind = 'checklist'
        AND r.onboarding_id IN (SELECT c.id FROM app.records c
          WHERE c.team_id = NEW.team_id AND c.id = ANY(children) AND c.kind = 'onboarding'));
    UPDATE app.records r SET org_unit_id = NEW.org_unit_id
      WHERE r.team_id = NEW.team_id AND r.id = ANY(checklist);
    UPDATE app.records r SET org_unit_id = NEW.org_unit_id
      WHERE r.team_id = NEW.team_id AND r.kind = 'comment'
        AND r.parent_record_id = ANY(ARRAY[NEW.id] || applications || children || checklist);
    RETURN NULL;
  END IF;
  IF NEW.kind = 'vacancy' THEN
    IF NEW.org_unit_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id)
       AND NOT EXISTS (SELECT 1 FROM app.org_units u JOIN app.workspace_teams t ON t.workspace_id = u.workspace_id
         WHERE t.team_id = NEW.team_id AND u.id = NEW.org_unit_id AND u.valid_to IS NULL AND u.archived_at IS NULL) THEN
      RAISE EXCEPTION 'The org unit is not a current unit of this company' USING ERRCODE = 'RQ012';
    END IF;
    NEW.scope_vacancy_id := NEW.id;
    NEW.scope_application_id := NULL;
  ELSIF NEW.kind = 'application' THEN
    SELECT * INTO parent FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.id = NEW.vacancy_id AND r.kind = 'vacancy';
    NEW.org_unit_id := parent.org_unit_id;
    NEW.scope_vacancy_id := NEW.vacancy_id;
    NEW.scope_application_id := NEW.id;
  ELSIF NEW.kind IN ('interview', 'offer', 'onboarding') THEN
    -- The application's own scope values: its unit, vacancy and id.
    SELECT * INTO parent FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.id = NEW.application_id AND r.kind = 'application';
    NEW.org_unit_id := parent.org_unit_id;
    NEW.scope_vacancy_id := parent.vacancy_id;
    NEW.scope_application_id := parent.id;
  ELSIF NEW.kind = 'checklist' THEN
    SELECT * INTO parent FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.id = NEW.onboarding_id AND r.kind = 'onboarding';
    NEW.org_unit_id := parent.org_unit_id;
    NEW.scope_vacancy_id := parent.scope_vacancy_id;
    NEW.scope_application_id := parent.scope_application_id;
  ELSIF NEW.kind = 'comment' THEN
    SELECT * INTO parent FROM app.records r
      WHERE r.team_id = NEW.team_id AND r.id = NEW.parent_record_id
        AND r.kind IN ('vacancy', 'application', 'interview', 'offer', 'onboarding', 'checklist');
    NEW.org_unit_id := parent.org_unit_id;
    NEW.scope_vacancy_id := parent.scope_vacancy_id;
    NEW.scope_application_id := parent.scope_application_id;
  ELSE
    NEW.org_unit_id := NULL;
    NEW.scope_vacancy_id := NULL;
    NEW.scope_application_id := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.maintain_record_scope() FROM PUBLIC;
CREATE TRIGGER records_scope BEFORE INSERT OR UPDATE ON app.records
  FOR EACH ROW EXECUTE FUNCTION app.maintain_record_scope();
CREATE TRIGGER records_scope_cascade AFTER UPDATE ON app.records
  FOR EACH ROW WHEN (NEW.kind = 'vacancy' AND NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id)
  EXECUTE FUNCTION app.maintain_record_scope();

-- Who is assigned to a record and how. Any relation puts the record in the member's scope.
-- approver is refused by the helpers until approval requests exist (R2c-04).
CREATE TABLE app.record_assignments (
  team_id text NOT NULL,
  record_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('recruiter', 'hiring-manager', 'interviewer', 'assignee', 'approver')),
  created_by text REFERENCES auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, record_id, user_id, relation),
  FOREIGN KEY (team_id, record_id) REFERENCES app.records(team_id, id) ON DELETE CASCADE
);
CREATE INDEX record_assignments_user_idx ON app.record_assignments(team_id, user_id);

-- Any context of the row's team reads. No runtime role inserts, updates or deletes: only the owner,
-- through the helpers below, employee erasure and the record foreign key.
DO $record_assignments_rls$ DECLARE command text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
  ALTER TABLE app.record_assignments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app.record_assignments FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON app.record_assignments FROM PUBLIC;
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.record_assignments FOR %s %s', 'record_assignments_owner_' || lower(command), command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  EXECUTE 'CREATE POLICY context_read ON app.record_assignments FOR SELECT USING (tenant_context.allows(team_id, NULL, ''read''))';
END $record_assignments_rls$;

-- The context's record scope and home units, derived by install (architecture 3.5, 6.5).
ALTER TABLE tenant_context.contexts ADD COLUMN record_scope jsonb, ADD COLUMN home_units uuid[];

-- The work of add_assignment and remove_assignment, run only through them: no role is granted it.
-- Refusals: 42501 without an unexpired context of this pid and xid holding a write scope; RQ015 for
-- the approver relation; RQ013 for any other relation outside the list, a record kind that takes no
-- assignment or a target user who is not a member of the context's team; RQ016 for a record that is
-- not in the context's team or not in its record scope; RQ014 when a caller whose record scope for the
-- record's group is not all assigns or unassigns themselves. The scope test is the service's
-- scopeFilter rule (src/lib/authz.ts) over the context's record scope, home units and assignments.
-- Adding an existing row or removing a missing one writes nothing; each change writes one
-- assignment activity row with ids only, through the owner-only branch of the insert policy.
CREATE FUNCTION tenant_context.change_assignment(target_record uuid, target_user text, target_relation text, adding boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  target app.records%ROWTYPE;
  home uuid[];
  pipeline_scope text;
  candidates_scope text;
  scope text;
  visible boolean;
  changed integer;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM unnest(ctx.scopes) s WHERE s LIKE '%:write') THEN
    RAISE EXCEPTION 'Assignment changes need a write context' USING ERRCODE = '42501';
  END IF;
  IF target_relation = 'approver' THEN
    RAISE EXCEPTION 'Approver assignments arrive with approval requests' USING ERRCODE = 'RQ015';
  END IF;
  IF target_record IS NULL OR target_user IS NULL
     OR target_relation IS NULL OR target_relation NOT IN ('recruiter', 'hiring-manager', 'interviewer', 'assignee') THEN
    RAISE EXCEPTION 'Assignment rejected' USING ERRCODE = 'RQ013';
  END IF;
  SELECT * INTO target FROM app.records r WHERE r.team_id = ctx.team_id AND r.id = target_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assignment record not found' USING ERRCODE = 'RQ016';
  END IF;
  IF target.kind NOT IN ('vacancy', 'application', 'interview', 'offer', 'onboarding', 'checklist', 'task') THEN
    RAISE EXCEPTION 'Assignment rejected' USING ERRCODE = 'RQ013';
  END IF;
  home := coalesce(ctx.home_units, '{}');
  pipeline_scope := ctx.record_scope->>'pipeline';
  candidates_scope := ctx.record_scope->>'candidates';
  scope := CASE WHEN target.kind = 'task' THEN ctx.record_scope->>'tasks' ELSE pipeline_scope END;
  IF scope IS NULL OR scope NOT IN ('all', 'unit', 'assigned') THEN
    RAISE EXCEPTION 'Assignment record not found' USING ERRCODE = 'RQ016';
  END IF;
  IF scope <> 'all' THEN
    -- A vacancy or task: an assignment on it; a pipeline row: on it, its application or its vacancy.
    visible := EXISTS (SELECT 1 FROM app.record_assignments a
        WHERE a.team_id = ctx.team_id AND a.user_id = ctx.actor_id
          AND a.record_id IN (target.id, target.scope_application_id, target.scope_vacancy_id))
      OR (scope = 'unit' AND target.kind <> 'task' AND EXISTS (SELECT 1 FROM app.org_unit_closure c
        WHERE c.ancestor_id = ANY(home) AND c.descendant_id = target.org_unit_id))
      OR (target.kind = 'task' AND target.created_by = ctx.actor_id)
      OR (target.kind = 'task' AND scope = 'unit' AND (
        EXISTS (SELECT 1 FROM app.records v
          WHERE v.team_id = ctx.team_id AND v.kind = 'vacancy' AND v.id = target.vacancy_id
            AND (pipeline_scope = 'all'
              OR (pipeline_scope = 'unit' AND EXISTS (SELECT 1 FROM app.org_unit_closure c
                WHERE c.ancestor_id = ANY(home) AND c.descendant_id = v.org_unit_id))
              OR EXISTS (SELECT 1 FROM app.record_assignments a
                WHERE a.team_id = ctx.team_id AND a.user_id = ctx.actor_id AND a.record_id = v.id)))
        OR EXISTS (SELECT 1 FROM app.records k
          WHERE k.team_id = ctx.team_id AND k.kind = 'candidate' AND k.id = target.candidate_id
            AND (candidates_scope = 'all' OR EXISTS (SELECT 1 FROM app.records p
              WHERE p.team_id = ctx.team_id AND p.kind = 'application' AND p.candidate_id = k.id
                AND ((candidates_scope = 'unit' AND EXISTS (SELECT 1 FROM app.org_unit_closure c
                    WHERE c.ancestor_id = ANY(home) AND c.descendant_id = p.org_unit_id))
                  OR EXISTS (SELECT 1 FROM app.record_assignments a
                    WHERE a.team_id = ctx.team_id AND a.user_id = ctx.actor_id
                      AND a.record_id IN (p.id, p.scope_application_id, p.scope_vacancy_id))))))));
    IF NOT visible THEN
      RAISE EXCEPTION 'Assignment record not found' USING ERRCODE = 'RQ016';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.member m WHERE m.organization_id = ctx.team_id AND m.user_id = target_user) THEN
    RAISE EXCEPTION 'Assignment rejected' USING ERRCODE = 'RQ013';
  END IF;
  IF target_user = ctx.actor_id AND scope <> 'all' THEN
    RAISE EXCEPTION 'A member with limited record scope cannot change their own assignments' USING ERRCODE = 'RQ014';
  END IF;
  IF adding THEN
    INSERT INTO app.record_assignments(team_id, record_id, user_id, relation, created_by, created_at)
      VALUES (ctx.team_id, target.id, target_user, target_relation, ctx.actor_id, now())
      ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM app.record_assignments a
      WHERE a.team_id = ctx.team_id AND a.record_id = target.id AND a.user_id = target_user AND a.relation = target_relation;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, target.id, ctx.actor_id, ctx.auth_type, ctx.token_id::uuid,
    CASE WHEN adding THEN 'assignment.added' ELSE 'assignment.removed' END, 'assignment',
    CASE WHEN adding THEN 'Assigned a member to a record' ELSE 'Removed a member from a record' END,
    jsonb_build_object('userId', target_user, 'relation', target_relation));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.change_assignment(uuid, text, text, boolean) FROM PUBLIC;

-- The two helpers the service calls (granted to the data role by the role template). True when a
-- row was added or removed.
CREATE FUNCTION tenant_context.add_assignment(record_id uuid, user_id text, relation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN tenant_context.change_assignment(add_assignment.record_id, add_assignment.user_id, add_assignment.relation, true);
END $$;
REVOKE ALL ON FUNCTION tenant_context.add_assignment(uuid, text, text) FROM PUBLIC;
CREATE FUNCTION tenant_context.remove_assignment(record_id uuid, user_id text, relation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN tenant_context.change_assignment(remove_assignment.record_id, remove_assignment.user_id, remove_assignment.relation, false);
END $$;
REVOKE ALL ON FUNCTION tenant_context.remove_assignment(uuid, text, text) FROM PUBLIC;

-- As in 0036, plus: assignment rows come only from the owner (the helpers above); no runtime role
-- inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND employee_erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory', 'role-assignment', 'employee-erasure', 'assignment') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND employee_erasure_id IS NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'employee-erasure' AND action = 'employee.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NULL AND employee_erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- As in 0035, without the record-scope refusal (RQ011): a published role limited to a unit or to
-- assigned records can be assigned now that the service enforces record scope.
CREATE OR REPLACE FUNCTION app.guard_member_role() RETURNS trigger
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
  IF NOT EXISTS (SELECT 1 FROM auth.member m
      WHERE m.organization_id = NEW.team_id AND m.user_id = NEW.user_id AND m.role <> 'owner') THEN
    RAISE EXCEPTION 'Assign roles to team members who are not team owners' USING ERRCODE = '42501';
  END IF;
  NEW.assigned_at := now();
  RETURN NEW;
END $$;

-- As in 0036, plus: when the erased employee had a linked user, that user's assignments are deleted
-- in every team of the workspace where they are no longer a member. These deletions write no
-- activity row and add nothing to the result or the employee.erased metadata.
CREATE OR REPLACE FUNCTION tenant_context.erase_employee(target uuid, confirm_name text, erasure_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  subject app.employees%ROWTYPE;
  earlier app.employee_erasures%ROWTYPE;
  earlier_counts jsonb;
  tombstone uuid := gen_random_uuid();
  erased_time timestamptz;
  position_rows integer;
  redacted integer;
  removed jsonb;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS DISTINCT FROM 'owner' OR ctx.workspace_id IS NULL
     OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Employee erasure rejected' USING ERRCODE = '42501';
  END IF;
  IF target IS NULL OR erasure_source IS NULL OR erasure_source NOT IN ('app', 'script') THEN
    RAISE EXCEPTION 'Employee erasure rejected' USING ERRCODE = '22023';
  END IF;
  -- A concurrent erasure of the same employee waits here, then finds the row gone and the tombstone.
  SELECT * INTO subject FROM app.employees e
    WHERE e.id = target AND e.workspace_id = ctx.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO earlier FROM app.employee_erasures x
      WHERE x.workspace_id = ctx.workspace_id AND x.employee_id = target;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT a.metadata INTO earlier_counts FROM app.activity a
      WHERE a.employee_erasure_id = earlier.id AND a.kind = 'employee-erasure' AND a.action = 'employee.erased';
    RETURN jsonb_build_object('erasureId', earlier.id, 'alreadyErased', true, 'erasedAt', earlier.erased_at,
      'removed', jsonb_build_object('positionRows', earlier_counts->'positionRows',
        'activityRedacted', earlier_counts->'activityRedacted', 'userLinks', earlier_counts->'userLinks'));
  END IF;
  IF btrim(coalesce(confirm_name, '')) = '' OR btrim(confirm_name) <> btrim(subject.display_name) THEN
    RAISE EXCEPTION 'Employee erasure confirmation mismatch' USING ERRCODE = 'RQ003';
  END IF;

  erased_time := clock_timestamp();
  -- First, so app.audit_directory_change writes nothing for the position rows deleted next.
  INSERT INTO app.employee_erasures(id, workspace_id, employee_id, erased_by, erased_at, erasure_source)
    VALUES (tombstone, ctx.workspace_id, target, ctx.actor_id, erased_time, erasure_source);
  DELETE FROM app.employee_positions ep WHERE ep.workspace_id = ctx.workspace_id AND ep.employee_id = target;
  GET DIAGNOSTICS position_rows = ROW_COUNT;
  DELETE FROM app.employees e WHERE e.workspace_id = ctx.workspace_id AND e.id = target;
  -- The directory and scope rows about the employee, in every team of the workspace.
  UPDATE app.activity a SET employee_erasure_id = tombstone, summary = 'Details removed by employee erasure',
    metadata = '{}'
    WHERE a.team_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id)
      AND a.metadata->>'employeeId' = target::text AND a.employee_erasure_id IS NULL;
  GET DIAGNOSTICS redacted = ROW_COUNT;
  -- Removing the user link changes that member's home units (architecture 6.5).
  IF subject.user_id IS NOT NULL THEN
    INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
    VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'scope.home_units_changed', 'scope',
      'Changed the employee facts that set home units',
      jsonb_build_object('workspaceId', ctx.workspace_id, 'affectedUserIds', jsonb_build_array(subject.user_id)));
    -- A former member's assignments go with the employee; a current member keeps theirs.
    DELETE FROM app.record_assignments ra
      WHERE ra.user_id = subject.user_id
        AND ra.team_id IN (SELECT t.team_id FROM app.workspace_teams t WHERE t.workspace_id = ctx.workspace_id)
        AND NOT EXISTS (SELECT 1 FROM auth.member m WHERE m.organization_id = ra.team_id AND m.user_id = ra.user_id);
  END IF;
  removed := jsonb_build_object('positionRows', position_rows, 'activityRedacted', redacted,
    'userLinks', CASE WHEN subject.user_id IS NULL THEN 0 ELSE 1 END);
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata,
    employee_erasure_id, created_at)
  VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, 'employee.erased', 'employee-erasure',
    'Permanently erased an employee',
    jsonb_build_object('source', erasure_source, 'workspaceId', ctx.workspace_id) || removed, tombstone, erased_time);
  RETURN jsonb_build_object('erasureId', tombstone, 'alreadyErased', false, 'erasedAt', erased_time,
    'removed', removed);
END $$;

-- As in 0035, with the record-scope step: a member without an app.member_roles row holds the
-- built-in template of member.role and record scope all in every group; a member whose role is
-- usable (a current published role of the workspace, not archived, with a scopes array and a
-- recordScope of all, unit or assigned in each group) holds that version, its narrowed scopes and its
-- record scope; any other row stores no scopes, no version and no record scope, so the context fails
-- closed. Every context also stores the actor's home units: the distinct units of the current,
-- non-archived positions held through current employee_positions rows by the employee linked to the
-- actor in the derived workspace (docs/security.md "Home-unit derivation"). The result also returns
-- recordScope and homeUnits (sorted).
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
    'recordScope', record_scope_held, 'homeUnits', to_jsonb(home));
END $$;

-- The code now depends on the scope columns, the assignments table and helpers and the record scope
-- and home units in install; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 16;
