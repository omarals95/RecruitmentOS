-- Release 1 clean-up (P1-23, job 038). Apply after 0026_mcp_cv_tools.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role the new budget table.
-- The storage schema marker is unchanged.

-- One row per member and team: the speed samples that member stored in the current clock hour.
-- Only team, user, hour start and a count; the samples themselves still never hold a user id.
CREATE TABLE app.speed_sample_budgets (
  team_id text NOT NULL REFERENCES auth.organization(id),
  user_id text NOT NULL REFERENCES auth."user"(id),
  window_start timestamptz NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  PRIMARY KEY (team_id, user_id)
);
ALTER TABLE app.speed_sample_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.speed_sample_budgets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.speed_sample_budgets FROM PUBLIC;
-- Each member reaches only their own row of their own team, viewers included; no delete.
CREATE POLICY context_read ON app.speed_sample_budgets FOR SELECT USING (tenant_context.allows(team_id, user_id, 'read'));
CREATE POLICY context_insert ON app.speed_sample_budgets FOR INSERT WITH CHECK (tenant_context.allows(team_id, user_id, 'read'));
CREATE POLICY context_update ON app.speed_sample_budgets FOR UPDATE
  USING (tenant_context.allows(team_id, user_id, 'read')) WITH CHECK (tenant_context.allows(team_id, user_id, 'read'));

-- As in 0021, except the name branch of the saved-view clearing: the trimmed name must have at least
-- 3 characters and appear in the search as a whole phrase, case-insensitively, with no letter or
-- digit directly before or after it. Every character of the name that is not a letter, digit or
-- space is backslash-escaped, so it matches literally. The signature, owner, SECURITY DEFINER,
-- search_path and execute rights are unchanged.
CREATE OR REPLACE FUNCTION tenant_context.erase_candidate(target uuid, confirm_name text, erasure_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  team text;
  earlier app.candidate_erasures%ROWTYPE;
  candidate app.records%ROWTYPE;
  candidate_name text;
  name_pattern text;
  candidate_email text;
  phone_digits text;
  application_ids uuid[];
  interview_ids uuid[];
  offer_ids uuid[];
  onboarding_ids uuid[];
  checklist_ids uuid[];
  comment_ids uuid[];
  erased_ids uuid[];
  erased_uploads uuid[];
  cleared_views uuid[];
  request_ids text[];
  tombstone uuid := gen_random_uuid();
  erased_time timestamptz;
  removed jsonb;
  redacted integer;
  redacted_requests integer;
  states_deleted integer;
  reads_deleted integer;
  keys_neutralised integer;
  items_tombstoned integer;
  files_erased integer;
  tasks_unlinked integer;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth.member m
       WHERE m.organization_id = ctx.team_id AND m.user_id = ctx.actor_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'Candidate erasure rejected' USING ERRCODE = '42501';
  END IF;
  IF target IS NULL OR erasure_source IS NULL OR erasure_source NOT IN ('app', 'script') THEN
    RAISE EXCEPTION 'Candidate erasure rejected' USING ERRCODE = '22023';
  END IF;
  team := ctx.team_id;
  -- The same key as lockTeam, so no record write of the team runs alongside.
  PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-records:' || team, 0));
  SELECT * INTO earlier FROM app.candidate_erasures e WHERE e.team_id = team AND e.candidate_id = target;
  IF FOUND THEN
    RETURN jsonb_build_object('erasureId', earlier.id, 'alreadyErased', true, 'erasedAt', earlier.erased_at);
  END IF;
  -- Ledger order: every store, then the team, then the candidate a CV reservation's FK check locks.
  PERFORM 1 FROM storage_ledger.stores s ORDER BY s.provider, s.store FOR UPDATE;
  PERFORM 1 FROM app.storage_usage u WHERE u.team_id = team FOR UPDATE;
  SELECT * INTO candidate FROM app.records r
    WHERE r.team_id = team AND r.id = target AND r.kind = 'candidate' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  candidate_name := btrim(coalesce(candidate.data->>'name', ''));
  IF btrim(coalesce(confirm_name, '')) = '' OR btrim(confirm_name) <> candidate_name THEN
    RAISE EXCEPTION 'Candidate erasure confirmation mismatch' USING ERRCODE = 'RQ003';
  END IF;

  application_ids := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'application' AND r.candidate_id = target);
  interview_ids := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'interview' AND r.application_id = ANY(application_ids));
  offer_ids := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'offer' AND r.application_id = ANY(application_ids));
  onboarding_ids := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'onboarding' AND r.application_id = ANY(application_ids));
  checklist_ids := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'checklist' AND r.onboarding_id = ANY(onboarding_ids));
  erased_ids := ARRAY[target] || application_ids || interview_ids || offer_ids || onboarding_ids || checklist_ids;
  comment_ids := ARRAY(WITH RECURSIVE thread(id) AS (
      SELECT r.id FROM app.records r
        WHERE r.team_id = team AND r.kind = 'comment' AND r.parent_record_id = ANY(erased_ids)
      UNION
      SELECT r.id FROM app.records r JOIN thread t ON r.parent_record_id = t.id
        WHERE r.team_id = team AND r.kind = 'comment')
    SELECT t.id FROM thread t);
  erased_ids := erased_ids || comment_ids;
  erased_uploads := ARRAY(SELECT x.id FROM app.uploads x WHERE x.team_id = team AND x.candidate_id = target);
  -- Read before the redaction below replaces the candidate's event metadata.
  request_ids := ARRAY(SELECT DISTINCT a.metadata->'aiReview'->>'requestId' FROM app.activity a
    WHERE a.team_id = team AND a.record_id = target AND a.metadata->'aiReview'->>'requestId' IS NOT NULL);
  -- Every member's saved views whose search names the candidate's name (as a whole phrase, for names
  -- of at least 3 characters), email or phone.
  name_pattern := '(^|[^[:alnum:]])' || regexp_replace(candidate_name, '([^[:alnum:] ])', '\\\1', 'g')
    || '($|[^[:alnum:]])';
  candidate_email := lower(btrim(coalesce(candidate.data->>'email', '')));
  phone_digits := regexp_replace(coalesce(candidate.data->>'phone', ''), '[^0-9]', '', 'g');
  cleared_views := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'saved-view' AND jsonb_typeof(r.data->'query'->'search') = 'string'
      AND r.data->'query'->>'search' <> ''
      AND ((char_length(candidate_name) >= 3 AND r.data->'query'->>'search' ~* name_pattern)
        OR (candidate_email <> '' AND strpos(lower(r.data->'query'->>'search'), candidate_email) > 0)
        OR (length(phone_digits) >= 7
          AND strpos(regexp_replace(r.data->'query'->>'search', '[^0-9]', '', 'g'), phone_digits) > 0)));

  erased_time := clock_timestamp();
  INSERT INTO app.candidate_erasures(id, team_id, candidate_id, erased_by, erased_at)
    VALUES (tombstone, team, target, ctx.actor_id, erased_time);

  UPDATE app.activity a SET record_id = NULL, erasure_id = tombstone,
    summary = 'Details removed by candidate erasure', metadata = '{}'
    WHERE a.team_id = team AND a.record_id = ANY(erased_ids);
  GET DIAGNOSTICS redacted = ROW_COUNT;
  -- The request id stays, so a used AI request is still refused.
  UPDATE app.activity a SET erasure_id = tombstone, summary = 'Details removed by candidate erasure',
    metadata = jsonb_build_object('requestId', a.metadata->>'requestId')
    WHERE a.team_id = team AND a.kind = 'ai-extraction' AND a.erasure_id IS NULL
      AND a.metadata->>'requestId' = ANY(request_ids);
  GET DIAGNOSTICS redacted_requests = ROW_COUNT;

  DELETE FROM app.notification_reads n
    WHERE n.team_id = team AND split_part(n.key, ':', 2) = ANY(erased_ids::text[]);
  GET DIAGNOSTICS reads_deleted = ROW_COUNT;

  -- An expired key runs its reconcile, which finds no record and answers 409; the payload hash stays.
  -- A saved view's create response holds its search text, so those keys are replaced as well.
  UPDATE app.idempotency i SET response = '{"erased":true}', expires_at = least(i.expires_at, erased_time)
    WHERE i.team_id = team AND EXISTS (SELECT 1 FROM unnest(erased_ids || erased_uploads || cleared_views) AS x(id)
      WHERE strpos(i.response::text, x.id::text) > 0);
  GET DIAGNOSTICS keys_neutralised = ROW_COUNT;

  DELETE FROM app.candidate_states s WHERE s.team_id = team AND s.candidate_id = target;
  GET DIAGNOSTICS states_deleted = ROW_COUNT;

  UPDATE app.bulk_intake_items i SET erased_at = erased_time, updated_at = erased_time,
    original_name = NULL, mime_type = NULL, size_bytes = NULL, payload_hash = NULL, reviewed_at = NULL,
    possible_duplicates = NULL, candidate_id = NULL, upload_id = NULL, upload_key = NULL
    WHERE i.team_id = team AND i.candidate_id = target;
  GET DIAGNOSTICS items_tombstoned = ROW_COUNT;

  -- The settle triggers move each charge; object key, expiry and deletion time keep the cleanup timing.
  UPDATE app.uploads x SET status = 'rejected', erasure_id = tombstone, candidate_id = NULL,
    original_name = NULL, source_path = NULL, legacy_source_id = NULL, blob_sha256 = NULL
    WHERE x.team_id = team AND x.candidate_id = target;
  GET DIAGNOSTICS files_erased = ROW_COUNT;

  UPDATE app.records r SET candidate_id = NULL, version = r.version + 1, updated_at = erased_time,
    data = r.data || jsonb_strip_nulls(jsonb_build_object(
      'title', CASE WHEN jsonb_typeof(r.data->'title') = 'string' THEN coalesce(nullif(btrim(left(
        regexp_replace(r.data->>'title', '***=' || candidate_name, '[erased candidate]', 'gi'), 200)), ''), '[erased candidate]') END,
      'context', CASE WHEN jsonb_typeof(r.data->'context') = 'string' THEN left(
        regexp_replace(r.data->>'context', '***=' || candidate_name, '[erased candidate]', 'gi'), 2000) END,
      'description', CASE WHEN jsonb_typeof(r.data->'description') = 'string' THEN left(
        regexp_replace(r.data->>'description', '***=' || candidate_name, '[erased candidate]', 'gi'), 10000) END))
    WHERE r.team_id = team AND r.kind = 'task' AND r.candidate_id = target;
  GET DIAGNOSTICS tasks_unlinked = ROW_COUNT;

  UPDATE app.records r SET data = jsonb_set(r.data, '{query,search}', '""'), version = r.version + 1,
    updated_at = erased_time
    WHERE r.team_id = team AND r.id = ANY(cleared_views);

  -- One statement, so the references among the erased records are checked once at its end.
  DELETE FROM app.records r WHERE r.team_id = team AND r.id = ANY(erased_ids);

  removed := jsonb_build_object('applications', cardinality(application_ids),
    'interviews', cardinality(interview_ids), 'offers', cardinality(offer_ids),
    'onboarding', cardinality(onboarding_ids), 'checklistItems', cardinality(checklist_ids),
    'comments', cardinality(comment_ids), 'followUpStates', states_deleted,
    'tasksUnlinked', tasks_unlinked, 'savedViewsCleared', cardinality(cleared_views), 'bulkItems', items_tombstoned,
    'cvFiles', files_erased, 'activityRedacted', redacted + redacted_requests,
    'notificationReads', reads_deleted, 'idempotencyKeys', keys_neutralised);
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata,
    erasure_id, created_at)
  VALUES (team, NULL, ctx.actor_id, 'session', NULL, 'candidate.erased', 'candidate-erasure',
    'Permanently erased a candidate', jsonb_build_object('source', erasure_source) || removed, tombstone, erased_time);
  RETURN jsonb_build_object('erasureId', tombstone, 'alreadyErased', false, 'erasedAt', erased_time,
    'removed', removed);
END $$;
REVOKE ALL ON FUNCTION tenant_context.erase_candidate(uuid, text, text) FROM PUBLIC;
