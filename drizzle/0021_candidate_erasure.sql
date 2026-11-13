-- Candidate erasure (P1-21, DEC-08): an owner-run helper permanently erases one candidate of the
-- caller's team and every record attached to it. Activity rows about it are redacted, never deleted,
-- and point to a tombstone that holds no personal data. Upload rows stay as nameless rejected rows,
-- so the existing Blob cleanup deletes their objects after ticket expiry and then frees the charge.

-- Only the id, team, candidate id, erasing owner and time. Owner-only: no runtime role reads or writes it.
CREATE TABLE app.candidate_erasures (
  id uuid PRIMARY KEY,
  team_id text NOT NULL REFERENCES auth.organization(id),
  candidate_id uuid NOT NULL,
  erased_by text NOT NULL REFERENCES auth."user"(id),
  erased_at timestamptz NOT NULL,
  UNIQUE (team_id, candidate_id),
  UNIQUE (team_id, id)
);
ALTER TABLE app.candidate_erasures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.candidate_erasures FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.candidate_erasures FROM PUBLIC;

ALTER TABLE app.activity ADD COLUMN erasure_id uuid,
  ADD CONSTRAINT activity_erasure_fkey FOREIGN KEY (team_id, erasure_id) REFERENCES app.candidate_erasures(team_id, id),
  ADD CONSTRAINT activity_erasure_check CHECK (erasure_id IS NULL OR record_id IS NULL);
CREATE INDEX activity_erasure_idx ON app.activity(team_id, erasure_id) WHERE erasure_id IS NOT NULL;

ALTER TABLE app.uploads ALTER COLUMN candidate_id DROP NOT NULL,
  ALTER COLUMN original_name DROP NOT NULL,
  ADD COLUMN erasure_id uuid,
  ADD CONSTRAINT uploads_erasure_fkey FOREIGN KEY (team_id, erasure_id) REFERENCES app.candidate_erasures(team_id, id),
  ADD CONSTRAINT uploads_erasure_check CHECK (CASE WHEN erasure_id IS NULL
    THEN candidate_id IS NOT NULL AND original_name IS NOT NULL
    ELSE status = 'rejected' AND candidate_id IS NULL AND original_name IS NULL AND source_path IS NULL
      AND legacy_source_id IS NULL AND blob_sha256 IS NULL END);
CREATE INDEX uploads_erasure_idx ON app.uploads(team_id, erasure_id) WHERE erasure_id IS NOT NULL;

ALTER TABLE app.bulk_intake_items ADD COLUMN erased_at timestamptz,
  ALTER COLUMN original_name DROP NOT NULL, ALTER COLUMN mime_type DROP NOT NULL,
  ALTER COLUMN size_bytes DROP NOT NULL, ALTER COLUMN payload_hash DROP NOT NULL,
  ADD CONSTRAINT bulk_intake_items_erased_check CHECK (CASE WHEN erased_at IS NULL
    THEN original_name IS NOT NULL AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND payload_hash IS NOT NULL
    ELSE original_name IS NULL AND mime_type IS NULL AND size_bytes IS NULL AND payload_hash IS NULL
      AND reviewed_at IS NULL AND possible_duplicates IS NULL AND candidate_id IS NULL
      AND upload_id IS NULL AND upload_key IS NULL END);

-- Append-only, except the owner-run erasure helper's redaction: it clears record_id, sets erasure_id
-- once and replaces summary and metadata. Id, team, actor, token, action, kind and time never change.
CREATE OR REPLACE FUNCTION app.prevent_activity_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND OLD.erasure_id IS NULL AND NEW.erasure_id IS NOT NULL AND NEW.record_id IS NULL
     AND (NEW.id, NEW.team_id, NEW.actor_id, NEW.actor_type, NEW.token_id, NEW.action, NEW.kind, NEW.created_at)
       IS NOT DISTINCT FROM (OLD.id, OLD.team_id, OLD.actor_id, OLD.actor_type, OLD.token_id, OLD.action, OLD.kind, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Activity history is append-only';
END $$;

-- As in 0019, plus: erasure_id changes only from null, and only as the owner (the erasure helper);
-- ready moves to rejected only in that same erasing update.
CREATE OR REPLACE FUNCTION storage_ledger.guard_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner_name text := (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
  erasing boolean := OLD.erasure_id IS NULL AND NEW.erasure_id IS NOT NULL AND current_user = owner_name;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('ready','rejected'))
     AND NOT (OLD.status = 'ready' AND NEW.status = 'rejected' AND erasing) THEN
    RAISE EXCEPTION 'Upload status transition rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.erasure_id IS DISTINCT FROM OLD.erasure_id
     AND (OLD.erasure_id IS NOT NULL OR current_user IS DISTINCT FROM owner_name) THEN
    RAISE EXCEPTION 'Upload reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.blob_deleted_at IS DISTINCT FROM OLD.blob_deleted_at
     AND (OLD.blob_deleted_at IS NOT NULL OR current_user IS DISTINCT FROM owner_name) THEN
    RAISE EXCEPTION 'Upload reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.put_tickets_issued IS DISTINCT FROM OLD.put_tickets_issued
     AND NOT (NEW.put_tickets_issued = OLD.put_tickets_issued + 1 AND OLD.storage_provider = 'blob'
              AND OLD.status = 'pending' AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'Upload reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF current_user IS DISTINCT FROM owner_name
     AND ((NEW.id, NEW.team_id, NEW.candidate_id, NEW.original_name, NEW.mime_type, NEW.size_bytes, NEW.object_key,
           NEW.storage_provider, NEW.storage_environment, NEW.storage_store, NEW.created_by, NEW.created_at,
           NEW.expires_at, NEW.legacy_source_id, NEW.source_path)
          IS DISTINCT FROM (OLD.id, OLD.team_id, OLD.candidate_id, OLD.original_name, OLD.mime_type, OLD.size_bytes, OLD.object_key,
           OLD.storage_provider, OLD.storage_environment, OLD.storage_store, OLD.created_by, OLD.created_at,
           OLD.expires_at, OLD.legacy_source_id, OLD.source_path)
       OR (NOT (OLD.status = 'pending' AND NEW.status = 'ready')
           AND (NEW.s3_version_id, NEW.blob_sha256, NEW.blob_size_bytes, NEW.completed_at)
             IS DISTINCT FROM (OLD.s3_version_id, OLD.blob_sha256, OLD.blob_size_bytes, OLD.completed_at))) THEN
    RAISE EXCEPTION 'Upload reference is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- An erased ready upload: its used charge becomes retained for Blob, so the cleanup frees it only after
-- the object is confirmed deleted, and is released for S3, as a rejected S3 ticket is. Unbound legacy
-- rows were charged to the team only.
CREATE FUNCTION storage_ledger.settle_erased_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  to_retained boolean := OLD.storage_provider = 'blob';
BEGIN
  IF OLD.storage_store IS NOT NULL THEN
    UPDATE storage_ledger.stores s SET used_bytes = s.used_bytes - OLD.size_bytes,
      used_files = s.used_files - 1,
      retained_bytes = s.retained_bytes + CASE WHEN to_retained THEN OLD.size_bytes ELSE 0 END,
      retained_files = s.retained_files + CASE WHEN to_retained THEN 1 ELSE 0 END,
      updated_at = clock_timestamp()
      WHERE s.provider = OLD.storage_provider AND s.store = OLD.storage_store;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE app.storage_usage u SET used_bytes = u.used_bytes - OLD.size_bytes,
    used_files = u.used_files - 1,
    retained_bytes = u.retained_bytes + CASE WHEN to_retained THEN OLD.size_bytes ELSE 0 END,
    retained_files = u.retained_files + CASE WHEN to_retained THEN 1 ELSE 0 END,
    updated_at = clock_timestamp()
    WHERE u.team_id = OLD.team_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION storage_ledger.settle_erased_upload() FROM PUBLIC;
CREATE TRIGGER uploads_settle_erased AFTER UPDATE ON app.uploads
  FOR EACH ROW WHEN (OLD.status = 'ready' AND NEW.status = 'rejected') EXECUTE FUNCTION storage_ledger.settle_erased_upload();

-- No runtime role inserts a row that names a tombstone or the erasure kind; only the helper below does.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
    OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'api-token' AND action = 'token.revoked' AND actor_type = 'token'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'export' AND action = 'records.exported' AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'storage-settings' AND action = 'storage.settings_updated' AND actor_type = 'session'
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- A tombstoned bulk item is read-only to runtime roles: a retry of its item ID is refused, never recreated.
DROP POLICY context_insert ON app.bulk_intake_items;
DROP POLICY context_update ON app.bulk_intake_items;
DROP POLICY context_delete ON app.bulk_intake_items;
CREATE POLICY context_insert ON app.bulk_intake_items FOR INSERT
  WITH CHECK (erased_at IS NULL AND tenant_context.allows(team_id, created_by, 'write'));
CREATE POLICY context_update ON app.bulk_intake_items FOR UPDATE
  USING (erased_at IS NULL AND tenant_context.allows(team_id, created_by, 'write'))
  WITH CHECK (erased_at IS NULL AND tenant_context.allows(team_id, created_by, 'write'));
CREATE POLICY context_delete ON app.bulk_intake_items FOR DELETE
  USING (erased_at IS NULL AND tenant_context.allows(team_id, created_by, 'write'));

-- Owner-only access for the erasure helper across every member's private rows of the team. A runtime
-- role is never the owner, so its access is unchanged.
DO $erasure_policies$ DECLARE spec text[]; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
  EXECUTE format('CREATE POLICY ledger_owner_update ON app.bulk_intake_items FOR UPDATE USING (%s) WITH CHECK (%s)', owner_only, owner_only);
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['records', 'SELECT'], ['records', 'UPDATE'], ['records', 'DELETE'],
    ['candidate_states', 'SELECT'], ['candidate_states', 'DELETE'],
    ['activity', 'SELECT'], ['activity', 'UPDATE'],
    ['idempotency', 'SELECT'], ['idempotency', 'UPDATE'],
    ['notification_reads', 'SELECT'], ['notification_reads', 'DELETE'],
    ['candidate_erasures', 'SELECT'], ['candidate_erasures', 'INSERT']
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'erasure_owner_' || lower(spec[2]), spec[1], spec[2],
      CASE spec[2]
        WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
        WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
        ELSE format('USING (%s)', owner_only) END);
  END LOOP;
END $erasure_policies$;

-- Owner sessions only, in the caller's transaction and under the team write lock. Team and actor come
-- from the verified context. Returns null when the team has no such candidate, the earlier result
-- when it was already erased, and otherwise the tombstone and counts; never a record value.
CREATE FUNCTION tenant_context.erase_candidate(target uuid, confirm_name text, erasure_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  team text;
  earlier app.candidate_erasures%ROWTYPE;
  candidate app.records%ROWTYPE;
  candidate_name text;
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
  -- Every member's saved views whose search names the candidate's name, email or phone.
  candidate_email := lower(btrim(coalesce(candidate.data->>'email', '')));
  phone_digits := regexp_replace(coalesce(candidate.data->>'phone', ''), '[^0-9]', '', 'g');
  cleared_views := ARRAY(SELECT r.id FROM app.records r
    WHERE r.team_id = team AND r.kind = 'saved-view' AND jsonb_typeof(r.data->'query'->'search') = 'string'
      AND r.data->'query'->>'search' <> ''
      AND (strpos(lower(r.data->'query'->>'search'), lower(candidate_name)) > 0
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

-- The code now depends on these columns and the helper; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 5;
