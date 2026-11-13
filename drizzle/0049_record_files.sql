-- File fields through the CV storage path (R2b-06, job 087). Apply after 0048_salary_brackets.sql,
-- then rerun infrastructure/postgres-split-runtime-roles.sql, which grants the data role SELECT,
-- INSERT and UPDATE on the new app.record_files; the identity role gets nothing, and no helper is
-- added or re-signed. A record file is a private Vercel Blob object of one record, stored exactly
-- like a CV: the same put tickets, size cap, digest, read leases and store and team ledger, under
-- guards and ledger triggers with the arithmetic of app.uploads. It is team data under forced
-- row-level security with the team policies and the restrictive record-scope policy of architecture
-- 3.5 keyed by record_id (D1, D4); no company authority opens it. tenant_context.release_blob_charge
-- also releases a rejected record file's retained charge, and tenant_context.erase_candidate also
-- erases the files of the records it deletes and counts them as recordFiles. No existing row is
-- rewritten. The storage schema marker goes to 27, so startup refuses a database without this
-- migration.

-- Blob only. original_name and record_id are null only on an erased row; the field value holding a
-- file is its id.
CREATE TABLE app.record_files (
  id uuid PRIMARY KEY,
  team_id text NOT NULL REFERENCES auth.organization(id),
  record_id uuid,
  original_name text,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 10485760),
  status text NOT NULL CHECK (status IN ('pending','ready','rejected')),
  object_key text NOT NULL,
  storage_provider text NOT NULL CHECK (storage_provider = 'blob'),
  storage_environment text NOT NULL CHECK (storage_environment IN ('development','preview','production')),
  storage_store text NOT NULL CHECK (storage_store ~ '^store_[A-Za-z0-9]{1,128}$'),
  blob_sha256 text CHECK (blob_sha256 ~ '^[0-9a-f]{64}$'),
  blob_size_bytes bigint CHECK (blob_size_bytes >= 1 AND blob_size_bytes <= 10485760),
  blob_deleted_at timestamptz,
  put_tickets_issued integer NOT NULL DEFAULT 0 CHECK (put_tickets_issued BETWEEN 0 AND 5),
  created_by text NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  erasure_id uuid,
  UNIQUE (team_id, id),
  CONSTRAINT record_files_record_fkey FOREIGN KEY (team_id, record_id) REFERENCES app.records(team_id, id),
  CONSTRAINT record_files_erasure_fkey FOREIGN KEY (team_id, erasure_id) REFERENCES app.candidate_erasures(team_id, id),
  CONSTRAINT record_files_ready_check CHECK (status <> 'ready'
    OR (completed_at IS NOT NULL AND blob_sha256 IS NOT NULL AND blob_size_bytes = size_bytes)),
  CONSTRAINT record_files_blob_deleted_check CHECK (blob_deleted_at IS NULL OR status = 'rejected'),
  CONSTRAINT record_files_erasure_check CHECK (CASE WHEN erasure_id IS NULL
    THEN record_id IS NOT NULL AND original_name IS NOT NULL
    ELSE status = 'rejected' AND record_id IS NULL AND original_name IS NULL AND blob_sha256 IS NULL END)
);
-- A pathname is never reused, whatever the team or status.
CREATE UNIQUE INDEX record_files_object_key_unique ON app.record_files(object_key);
CREATE INDEX record_files_team_record_idx ON app.record_files(team_id, record_id);
CREATE INDEX record_files_team_created_idx ON app.record_files(team_id, created_at);
CREATE INDEX record_files_blob_cleanup_idx ON app.record_files(team_id, storage_store, expires_at)
  WHERE status = 'rejected' AND blob_deleted_at IS NULL;
CREATE INDEX record_files_erasure_idx ON app.record_files(team_id, erasure_id) WHERE erasure_id IS NOT NULL;

-- The team policies of app.uploads (0006) with no runtime delete, the owner-only ledger policies of
-- 0007 for the owner-run helpers, and the restrictive record-scope policy of 0038 keyed by record_id.
-- No workspace or company-authority policy (D1).
ALTER TABLE app.record_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.record_files FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.record_files FROM PUBLIC;
DO $record_files_rls$ DECLARE owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
  scoped text := '(SELECT tenant_context.scope_is_all()) OR record_id IS NULL OR tenant_context.record_in_scope(team_id, record_id)';
BEGIN
  CREATE POLICY context_read ON app.record_files FOR SELECT USING (tenant_context.allows(team_id, NULL, 'read'));
  CREATE POLICY context_insert ON app.record_files FOR INSERT WITH CHECK (tenant_context.allows(team_id, NULL, 'write'));
  CREATE POLICY context_update ON app.record_files FOR UPDATE
    USING (tenant_context.allows(team_id, NULL, 'write')) WITH CHECK (tenant_context.allows(team_id, NULL, 'write'));
  EXECUTE format('CREATE POLICY ledger_owner_read ON app.record_files FOR SELECT USING (%s)', owner_only);
  EXECUTE format('CREATE POLICY ledger_owner_update ON app.record_files FOR UPDATE USING (%s) WITH CHECK (%s)',
    owner_only, owner_only);
  EXECUTE format('CREATE POLICY record_scope ON app.record_files AS RESTRICTIVE FOR ALL USING (%s OR %s) WITH CHECK (%s OR %s)',
    owner_only, scoped, owner_only, scoped);
END $record_files_rls$;

-- As storage_ledger.guard_upload (0021) for a Blob-only row keyed by record: status moves only from
-- pending, or from ready to rejected in the owner's erasing update; erasure_id and blob_deleted_at
-- are set once, by the owner only; put_tickets_issued grows only by exactly 1 on a row that stays
-- pending; other callers cannot rewrite the reference, or its result outside pending to ready.
CREATE FUNCTION storage_ledger.guard_record_file() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner_name text := (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
  erasing boolean := OLD.erasure_id IS NULL AND NEW.erasure_id IS NOT NULL AND current_user = owner_name;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('ready','rejected'))
     AND NOT (OLD.status = 'ready' AND NEW.status = 'rejected' AND erasing) THEN
    RAISE EXCEPTION 'Record file status transition rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.erasure_id IS DISTINCT FROM OLD.erasure_id
     AND (OLD.erasure_id IS NOT NULL OR current_user IS DISTINCT FROM owner_name) THEN
    RAISE EXCEPTION 'Record file reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.blob_deleted_at IS DISTINCT FROM OLD.blob_deleted_at
     AND (OLD.blob_deleted_at IS NOT NULL OR current_user IS DISTINCT FROM owner_name) THEN
    RAISE EXCEPTION 'Record file reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.put_tickets_issued IS DISTINCT FROM OLD.put_tickets_issued
     AND NOT (NEW.put_tickets_issued = OLD.put_tickets_issued + 1
              AND OLD.status = 'pending' AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'Record file reference is immutable' USING ERRCODE = '23514';
  END IF;
  IF current_user IS DISTINCT FROM owner_name
     AND ((NEW.id, NEW.team_id, NEW.record_id, NEW.original_name, NEW.mime_type, NEW.size_bytes, NEW.object_key,
           NEW.storage_provider, NEW.storage_environment, NEW.storage_store, NEW.created_by, NEW.created_at,
           NEW.expires_at)
          IS DISTINCT FROM (OLD.id, OLD.team_id, OLD.record_id, OLD.original_name, OLD.mime_type, OLD.size_bytes, OLD.object_key,
           OLD.storage_provider, OLD.storage_environment, OLD.storage_store, OLD.created_by, OLD.created_at,
           OLD.expires_at)
       OR (NOT (OLD.status = 'pending' AND NEW.status = 'ready')
           AND (NEW.blob_sha256, NEW.blob_size_bytes, NEW.completed_at)
             IS DISTINCT FROM (OLD.blob_sha256, OLD.blob_size_bytes, OLD.completed_at))) THEN
    RAISE EXCEPTION 'Record file reference is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- storage_ledger.charge_upload (0007) for this table, which has no s3_version_id: store, then team,
-- then refuse a reservation either budget cannot hold. The BEFORE pass validates and refuses; the
-- AFTER pass charges.
CREATE FUNCTION storage_ledger.charge_record_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  store_row storage_ledger.stores%ROWTYPE;
  budget_row storage_ledger.budgets%ROWTYPE;
  team_row app.storage_usage%ROWTYPE;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.blob_sha256 IS NOT NULL OR NEW.blob_size_bytes IS NOT NULL
     OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO store_row FROM storage_ledger.stores s
    WHERE s.provider = NEW.storage_provider AND s.store = NEW.storage_store FOR UPDATE;
  IF NOT FOUND OR store_row.environment IS DISTINCT FROM NEW.storage_environment THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO budget_row FROM storage_ledger.budgets b WHERE b.environment = store_row.environment;
  SELECT * INTO team_row FROM app.storage_usage u WHERE u.team_id = NEW.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  IF store_row.used_bytes + store_row.reserved_bytes + store_row.retained_bytes + NEW.size_bytes > budget_row.max_bytes
     OR store_row.used_files + store_row.reserved_files + store_row.retained_files + 1 > budget_row.max_files
     OR team_row.used_bytes + team_row.reserved_bytes + team_row.retained_bytes + NEW.size_bytes
       > coalesce(team_row.max_bytes, budget_row.max_bytes)
     OR team_row.used_files + team_row.reserved_files + team_row.retained_files + 1
       > coalesce(team_row.max_files, budget_row.max_files) THEN
    RAISE EXCEPTION 'Storage quota exceeded' USING ERRCODE = 'RQ001';
  END IF;
  IF TG_WHEN = 'BEFORE' THEN
    RETURN NEW;
  END IF;
  UPDATE storage_ledger.stores s SET reserved_bytes = s.reserved_bytes + NEW.size_bytes,
    reserved_files = s.reserved_files + 1, updated_at = clock_timestamp()
    WHERE s.provider = NEW.storage_provider AND s.store = NEW.storage_store;
  UPDATE app.storage_usage u SET reserved_bytes = u.reserved_bytes + NEW.size_bytes,
    reserved_files = u.reserved_files + 1, updated_at = clock_timestamp()
    WHERE u.team_id = NEW.team_id;
  RETURN NULL;
END $$;

-- storage_ledger.settle_upload (0007) for a Blob row: ready moves the insert-time charge to used, and
-- rejected keeps it as retained until the cleanup confirms the object deleted.
CREATE FUNCTION storage_ledger.settle_record_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  to_used boolean := NEW.status = 'ready';
  to_retained boolean := NEW.status = 'rejected';
BEGIN
  UPDATE storage_ledger.stores s SET reserved_bytes = s.reserved_bytes - OLD.size_bytes,
    reserved_files = s.reserved_files - 1,
    used_bytes = s.used_bytes + CASE WHEN to_used THEN OLD.size_bytes ELSE 0 END,
    used_files = s.used_files + CASE WHEN to_used THEN 1 ELSE 0 END,
    retained_bytes = s.retained_bytes + CASE WHEN to_retained THEN OLD.size_bytes ELSE 0 END,
    retained_files = s.retained_files + CASE WHEN to_retained THEN 1 ELSE 0 END,
    updated_at = clock_timestamp()
    WHERE s.provider = OLD.storage_provider AND s.store = OLD.storage_store;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
  END IF;
  UPDATE app.storage_usage u SET reserved_bytes = u.reserved_bytes - OLD.size_bytes,
    reserved_files = u.reserved_files - 1,
    used_bytes = u.used_bytes + CASE WHEN to_used THEN OLD.size_bytes ELSE 0 END,
    used_files = u.used_files + CASE WHEN to_used THEN 1 ELSE 0 END,
    retained_bytes = u.retained_bytes + CASE WHEN to_retained THEN OLD.size_bytes ELSE 0 END,
    retained_files = u.retained_files + CASE WHEN to_retained THEN 1 ELSE 0 END,
    updated_at = clock_timestamp()
    WHERE u.team_id = OLD.team_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

-- storage_ledger.settle_erased_upload (0021) for a Blob row: an erased ready file's used charge
-- becomes retained, so the cleanup frees it only after the object is confirmed deleted.
CREATE FUNCTION storage_ledger.settle_erased_record_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE storage_ledger.stores s SET used_bytes = s.used_bytes - OLD.size_bytes,
    used_files = s.used_files - 1,
    retained_bytes = s.retained_bytes + OLD.size_bytes,
    retained_files = s.retained_files + 1,
    updated_at = clock_timestamp()
    WHERE s.provider = OLD.storage_provider AND s.store = OLD.storage_store;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
  END IF;
  UPDATE app.storage_usage u SET used_bytes = u.used_bytes - OLD.size_bytes,
    used_files = u.used_files - 1,
    retained_bytes = u.retained_bytes + OLD.size_bytes,
    retained_files = u.retained_files + 1,
    updated_at = clock_timestamp()
    WHERE u.team_id = OLD.team_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER record_files_guard BEFORE UPDATE ON app.record_files
  FOR EACH ROW EXECUTE FUNCTION storage_ledger.guard_record_file();
CREATE TRIGGER record_files_charge BEFORE INSERT ON app.record_files
  FOR EACH ROW EXECUTE FUNCTION storage_ledger.charge_record_file();
CREATE TRIGGER record_files_charge_applied AFTER INSERT ON app.record_files
  FOR EACH ROW EXECUTE FUNCTION storage_ledger.charge_record_file();
CREATE TRIGGER record_files_settle AFTER UPDATE ON app.record_files
  FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status <> 'pending') EXECUTE FUNCTION storage_ledger.settle_record_file();
CREATE TRIGGER record_files_settle_erased AFTER UPDATE ON app.record_files
  FOR EACH ROW WHEN (OLD.status = 'ready' AND NEW.status = 'rejected') EXECUTE FUNCTION storage_ledger.settle_erased_record_file();
CREATE TRIGGER record_files_owner_only BEFORE DELETE OR TRUNCATE ON app.record_files
  FOR EACH STATEMENT EXECUTE FUNCTION storage_ledger.refuse_unless_owner();
REVOKE ALL ON FUNCTION storage_ledger.guard_record_file() FROM PUBLIC;
REVOKE ALL ON FUNCTION storage_ledger.charge_record_file() FROM PUBLIC;
REVOKE ALL ON FUNCTION storage_ledger.settle_record_file() FROM PUBLIC;
REVOKE ALL ON FUNCTION storage_ledger.settle_erased_record_file() FROM PUBLIC;

-- As in 0018, plus: when no upload matches, the rejected Blob record file of the context's team with
-- this id is released on the same conditions. Store, then team, then the row. The signature, owner,
-- SECURITY DEFINER, search_path and execute rights are unchanged.
CREATE OR REPLACE FUNCTION tenant_context.release_blob_charge(binding_store text, upload_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  released_bytes bigint;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND 'cvs:write' = ANY(c.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blob charge release rejected' USING ERRCODE = '42501';
  END IF;
  IF binding_store IS NULL OR binding_store !~ '^store_[A-Za-z0-9]{1,128}$' THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  PERFORM 1 FROM storage_ledger.stores s WHERE s.provider = 'blob' AND s.store = binding_store FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  PERFORM 1 FROM app.storage_usage u WHERE u.team_id = ctx.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT x.size_bytes INTO released_bytes FROM app.uploads x
    WHERE x.team_id = ctx.team_id AND x.id = upload_id AND x.storage_provider = 'blob'
      AND x.storage_store = binding_store AND x.status = 'rejected' AND x.blob_deleted_at IS NULL
      AND x.expires_at <= clock_timestamp() - interval '10 minutes'
    FOR UPDATE;
  IF FOUND THEN
    UPDATE app.uploads x SET blob_deleted_at = clock_timestamp()
      WHERE x.team_id = ctx.team_id AND x.id = upload_id;
  ELSE
    SELECT f.size_bytes INTO released_bytes FROM app.record_files f
      WHERE f.team_id = ctx.team_id AND f.id = upload_id AND f.storage_provider = 'blob'
        AND f.storage_store = binding_store AND f.status = 'rejected' AND f.blob_deleted_at IS NULL
        AND f.expires_at <= clock_timestamp() - interval '10 minutes'
      FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    UPDATE app.record_files f SET blob_deleted_at = clock_timestamp()
      WHERE f.team_id = ctx.team_id AND f.id = upload_id;
  END IF;
  UPDATE storage_ledger.stores s SET retained_bytes = s.retained_bytes - released_bytes,
    retained_files = s.retained_files - 1, updated_at = clock_timestamp()
    WHERE s.provider = 'blob' AND s.store = binding_store;
  UPDATE app.storage_usage u SET retained_bytes = u.retained_bytes - released_bytes,
    retained_files = u.retained_files - 1, updated_at = clock_timestamp()
    WHERE u.team_id = ctx.team_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.release_blob_charge(text, uuid) FROM PUBLIC;

-- As in 0027, plus: every record file of an erased record (the candidate, its applications,
-- interviews, offers, onboarding, checklist items and the comments on any of them) becomes rejected,
-- nameless and unlinked before the records are deleted, so the existing Blob cleanup deletes its
-- object and frees the charge; its id joins the neutralised idempotency responses, and the count is
-- removed.recordFiles. The signature, owner, SECURITY DEFINER, search_path and execute rights are
-- unchanged.
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
  erased_record_files uuid[];
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
  record_files_erased integer;
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
  erased_record_files := ARRAY(SELECT f.id FROM app.record_files f
    WHERE f.team_id = team AND f.record_id = ANY(erased_ids));
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
    WHERE i.team_id = team AND EXISTS (SELECT 1
      FROM unnest(erased_ids || erased_uploads || erased_record_files || cleared_views) AS x(id)
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
  -- The same for the erased records' files, in every status, before the records go.
  UPDATE app.record_files f SET status = 'rejected', erasure_id = tombstone, record_id = NULL,
    original_name = NULL, blob_sha256 = NULL
    WHERE f.team_id = team AND f.record_id = ANY(erased_ids);
  GET DIAGNOSTICS record_files_erased = ROW_COUNT;

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
    'cvFiles', files_erased, 'recordFiles', record_files_erased, 'activityRedacted', redacted + redacted_requests,
    'notificationReads', reads_deleted, 'idempotencyKeys', keys_neutralised);
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata,
    erasure_id, created_at)
  VALUES (team, NULL, ctx.actor_id, 'session', NULL, 'candidate.erased', 'candidate-erasure',
    'Permanently erased a candidate', jsonb_build_object('source', erasure_source) || removed, tombstone, erased_time);
  RETURN jsonb_build_object('erasureId', tombstone, 'alreadyErased', false, 'erasedAt', erased_time,
    'removed', removed);
END $$;
REVOKE ALL ON FUNCTION tenant_context.erase_candidate(uuid, text, text) FROM PUBLIC;

-- The code now reads and writes record files; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 27;
