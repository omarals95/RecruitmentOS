-- Record scope in row-level security (R2a-19, job 061). Apply after 0037_record_scope.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role EXECUTE on
-- tenant_context.scope_is_all(), tenant_context.in_scope(text, text, uuid, uuid, uuid, uuid, uuid,
-- text, uuid, uuid), tenant_context.record_in_scope(text, uuid), tenant_context.candidate_in_scope(text,
-- uuid) and tenant_context.context_actor_key(): the new policies call them as the querying role, so
-- until then every request touching the five tables fails. Restrictive policies limit app.records,
-- app.activity, app.uploads and app.record_assignments to the context's record scope (the service's
-- scopeFilter rule, src/lib/authz.ts), and app.idempotency to the context's own actor key; every
-- existing permissive policy stays. app.idempotency gains a nullable role_version_id. No business row
-- is rewritten. The storage schema marker goes to 17, so startup refuses a database without this
-- migration.

-- True only when the verified context's record scope is all in each of the three groups. A context
-- that failed closed (null record scope), a partial scope or no context is false.
CREATE FUNCTION tenant_context.scope_is_all() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp()
      AND c.record_scope->>'pipeline' = 'all' AND c.record_scope->>'candidates' = 'all'
      AND c.record_scope->>'tasks' = 'all')
$$;
REVOKE ALL ON FUNCTION tenant_context.scope_is_all() FROM PUBLIC;

-- The candidate rule: a candidate of the context's team with an application in scope under the
-- candidates group's scope (under a home unit for unit, or an assignment of the actor on the
-- application, its application or its vacancy). The probe uses records_application_candidate_idx. A
-- missing, other-team or out-of-scope candidate is false alike.
CREATE FUNCTION tenant_context.candidate_in_scope(row_team text, candidate_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    JOIN app.records k ON k.team_id = c.team_id AND k.kind = 'candidate' AND k.id = candidate_in_scope.candidate_id
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.team_id = row_team AND c.record_scope IS NOT NULL
      AND (c.record_scope->>'candidates' = 'all' OR EXISTS (SELECT 1 FROM app.records a
        WHERE a.team_id = c.team_id AND a.kind = 'application' AND a.candidate_id = k.id
          AND ((c.record_scope->>'candidates' = 'unit' AND EXISTS (SELECT 1 FROM app.org_unit_closure u
              WHERE u.ancestor_id = ANY(coalesce(c.home_units, '{}')) AND u.descendant_id = a.org_unit_id))
            OR EXISTS (SELECT 1 FROM app.record_assignments ra
              WHERE ra.team_id = c.team_id AND ra.user_id = c.actor_id
                AND ra.record_id IN (a.id, a.scope_application_id, a.scope_vacancy_id))))))
$$;
REVOKE ALL ON FUNCTION tenant_context.candidate_in_scope(text, uuid) FROM PUBLIC;

-- Whether a record row, given by its columns, is in the verified context's record scope: the rule of
-- scopeRule and anyRecordScopeRule in src/lib/authz.ts, kind by kind. The columns come from the row
-- itself, so a WITH CHECK tests the new row as the before trigger left it. False for another team or
-- a null record scope; true for kinds without a rule (job-role, bucket, task-field, shared-view and
-- saved-view, whose private owner the existing policies keep). A comment takes the rule of its
-- nearest ancestor that is not a comment, found through parent_record_id in the same team; the
-- CYCLE clause ends a loop of comments re-pointed into each other, which then has no such ancestor
-- and is not in scope, while an acyclic chain of any depth is walked to its end.
CREATE FUNCTION tenant_context.in_scope(row_team text, row_kind text, row_id uuid, row_org_unit uuid,
  row_candidate uuid, row_scope_vacancy uuid, row_scope_application uuid, row_created_by text,
  row_vacancy uuid, row_parent uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  home uuid[];
  pipeline_scope text;
  candidates_scope text;
  tasks_scope text;
  target app.records%ROWTYPE;
  visible boolean;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND OR ctx.team_id IS DISTINCT FROM row_team OR ctx.record_scope IS NULL THEN
    RETURN false;
  END IF;
  home := coalesce(ctx.home_units, '{}');
  pipeline_scope := ctx.record_scope->>'pipeline';
  candidates_scope := ctx.record_scope->>'candidates';
  tasks_scope := ctx.record_scope->>'tasks';
  IF pipeline_scope = 'all' AND candidates_scope = 'all' AND tasks_scope = 'all' THEN
    RETURN true;
  END IF;
  target.kind := row_kind;
  target.id := row_id;
  target.org_unit_id := row_org_unit;
  target.candidate_id := row_candidate;
  target.scope_vacancy_id := row_scope_vacancy;
  target.scope_application_id := row_scope_application;
  target.created_by := row_created_by;
  target.vacancy_id := row_vacancy;
  IF row_kind = 'comment' THEN
    SELECT r.* INTO target FROM app.records r
      WHERE r.team_id = row_team AND r.id = (
        WITH RECURSIVE up(id, kind, parent_record_id) AS (
          SELECT x.id, x.kind, x.parent_record_id FROM app.records x
            WHERE x.team_id = row_team AND x.id = row_parent
          UNION ALL
          SELECT x.id, x.kind, x.parent_record_id FROM up
            JOIN app.records x ON x.team_id = row_team AND x.id = up.parent_record_id
            WHERE up.kind = 'comment'
        ) CYCLE id SET looped USING path
        SELECT up.id FROM up WHERE up.kind <> 'comment' AND NOT up.looped LIMIT 1);
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  IF target.kind = 'vacancy' THEN
    visible := pipeline_scope = 'all'
      OR (pipeline_scope = 'unit' AND EXISTS (SELECT 1 FROM app.org_unit_closure c
        WHERE c.ancestor_id = ANY(home) AND c.descendant_id = target.org_unit_id))
      OR EXISTS (SELECT 1 FROM app.record_assignments a
        WHERE a.team_id = row_team AND a.user_id = ctx.actor_id AND a.record_id = target.id);
  ELSIF target.kind IN ('application', 'interview', 'offer', 'onboarding', 'checklist') THEN
    visible := pipeline_scope = 'all'
      OR (pipeline_scope = 'unit' AND EXISTS (SELECT 1 FROM app.org_unit_closure c
        WHERE c.ancestor_id = ANY(home) AND c.descendant_id = target.org_unit_id))
      OR EXISTS (SELECT 1 FROM app.record_assignments a
        WHERE a.team_id = row_team AND a.user_id = ctx.actor_id
          AND a.record_id IN (target.id, target.scope_application_id, target.scope_vacancy_id));
  ELSIF target.kind = 'candidate' THEN
    visible := candidates_scope = 'all' OR tenant_context.candidate_in_scope(row_team, target.id);
  ELSIF target.kind = 'task' THEN
    visible := tasks_scope = 'all' OR target.created_by = ctx.actor_id
      OR EXISTS (SELECT 1 FROM app.record_assignments a
        WHERE a.team_id = row_team AND a.user_id = ctx.actor_id AND a.record_id = target.id)
      OR (tasks_scope = 'unit' AND (tenant_context.candidate_in_scope(row_team, target.candidate_id)
        OR EXISTS (SELECT 1 FROM app.records v
          WHERE v.team_id = row_team AND v.kind = 'vacancy' AND v.id = target.vacancy_id
            AND (pipeline_scope = 'all'
              OR (pipeline_scope = 'unit' AND EXISTS (SELECT 1 FROM app.org_unit_closure c
                WHERE c.ancestor_id = ANY(home) AND c.descendant_id = v.org_unit_id))
              OR EXISTS (SELECT 1 FROM app.record_assignments a
                WHERE a.team_id = row_team AND a.user_id = ctx.actor_id AND a.record_id = v.id)))));
  ELSE
    visible := true;
  END IF;
  RETURN coalesce(visible, false);
END $$;
REVOKE ALL ON FUNCTION tenant_context.in_scope(text, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) FROM PUBLIC;

-- in_scope of the record with this id in this team; a missing or other-team record is false.
CREATE FUNCTION tenant_context.record_in_scope(row_team text, record_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT tenant_context.in_scope(r.team_id, r.kind, r.id, r.org_unit_id, r.candidate_id,
      r.scope_vacancy_id, r.scope_application_id, r.created_by, r.vacancy_id, r.parent_record_id)
    FROM app.records r WHERE r.team_id = row_team AND r.id = record_in_scope.record_id), false)
$$;
REVOKE ALL ON FUNCTION tenant_context.record_in_scope(text, uuid) FROM PUBLIC;

-- The key idempotent() in src/lib/records.ts builds, from the verified context row: user, auth type and
-- token id or "session". Null without a context.
CREATE FUNCTION tenant_context.context_actor_key() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.actor_id || ':' || c.auth_type || ':' || coalesce(c.token_id, 'session')
  FROM tenant_context.contexts c
  WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
    AND c.expires_at > clock_timestamp()
$$;
REVOKE ALL ON FUNCTION tenant_context.context_actor_key() FROM PUBLIC;

-- Restrictive, so they only remove rows the existing policies allow. Each is true for the owner, as
-- in 0021: the helpers above read these tables as the owner and never re-enter a policy, and the
-- owner-run helpers (erasure, assignments, the record-scope cascade) reach every row. The scalar
-- subquery is an InitPlan evaluated once per statement, so a scope-all context pays no per-row cost.
-- A null record or candidate id (an erased activity or upload row, a team event) is left to the
-- existing policies. Idempotency rows belong to their own actor under every context.
DO $record_scope_rls$ DECLARE spec text[]; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['records', 'record_scope', '(SELECT tenant_context.scope_is_all()) OR tenant_context.in_scope(team_id, kind, id, org_unit_id, candidate_id, scope_vacancy_id, scope_application_id, created_by, vacancy_id, parent_record_id)'],
    ['activity', 'record_scope', '(SELECT tenant_context.scope_is_all()) OR record_id IS NULL OR tenant_context.record_in_scope(team_id, record_id)'],
    ['uploads', 'record_scope', '(SELECT tenant_context.scope_is_all()) OR candidate_id IS NULL OR tenant_context.candidate_in_scope(team_id, candidate_id)'],
    ['record_assignments', 'record_scope', '(SELECT tenant_context.scope_is_all()) OR tenant_context.record_in_scope(team_id, record_id)'],
    ['idempotency', 'actor_only', 'actor_key = (SELECT tenant_context.context_actor_key())']
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I AS RESTRICTIVE FOR ALL USING (%s OR %s) WITH CHECK (%s OR %s)',
      spec[2], spec[1], owner_only, spec[3], owner_only, spec[3]);
  END LOOP;
END $record_scope_rls$;

-- The role version each cached response was composed under; a replay under another version (or a
-- row written before this migration) is recomposed, never returned from the cache.
ALTER TABLE app.idempotency ADD COLUMN role_version_id uuid;

-- The code now writes role_version_id and depends on the policies above; startup refuses a database
-- without them.
UPDATE db_boundary.storage_schema SET version = 17;
