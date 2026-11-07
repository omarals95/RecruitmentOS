-- Team storage limits and an upload rate set by owners and admins, deletion-confirmed release of
-- retained Blob charges, and the indexes for the rate check and the cleanup scan. Budgets are unchanged.

-- A team limit may be set below current usage: new reservations are refused by charge_upload, while
-- settling existing ones must still succeed, so the row-level limit checks go.
ALTER TABLE app.storage_usage
  DROP CONSTRAINT storage_usage_bytes_limit_check,
  DROP CONSTRAINT storage_usage_files_limit_check,
  ADD COLUMN upload_requests_per_minute integer
    CHECK (upload_requests_per_minute IS NULL OR upload_requests_per_minute BETWEEN 1 AND 600);

-- Set once, by the release helper, when the object is confirmed deleted and its retained charge freed.
ALTER TABLE app.uploads
  ADD COLUMN blob_deleted_at timestamptz,
  ADD CONSTRAINT uploads_blob_deleted_check
    CHECK (blob_deleted_at IS NULL OR (storage_provider = 'blob' AND status = 'rejected'));
CREATE INDEX uploads_team_created_idx ON app.uploads(team_id, created_at);
CREATE INDEX uploads_blob_cleanup_idx ON app.uploads(team_id, storage_store, expires_at)
  WHERE storage_provider = 'blob' AND status = 'rejected' AND blob_deleted_at IS NULL;

-- As in 0007, plus: blob_deleted_at changes only from null, and only as the owner (the helper below).
CREATE OR REPLACE FUNCTION storage_ledger.guard_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner_name text := (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('ready','rejected')) THEN
    RAISE EXCEPTION 'Upload status transition rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.blob_deleted_at IS DISTINCT FROM OLD.blob_deleted_at
     AND (OLD.blob_deleted_at IS NOT NULL OR current_user IS DISTINCT FROM owner_name) THEN
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

-- Owner and admin sessions only. Team and actor come from the verified context. Null turns a limit off;
-- the store budget always applies. Writes one audit row per actual change and returns whether it changed.
CREATE FUNCTION tenant_context.set_storage_limits(limit_bytes bigint, limit_files integer, upload_rate integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  before_row app.storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth.member m
       WHERE m.organization_id = ctx.team_id AND m.user_id = ctx.actor_id AND m.role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'Storage settings rejected' USING ERRCODE = '42501';
  END IF;
  IF (limit_bytes IS NULL) <> (limit_files IS NULL)
     OR limit_bytes NOT BETWEEN 1000000 AND 10000000000000
     OR limit_files NOT BETWEEN 1 AND 1000000
     OR upload_rate NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Storage settings rejected' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.storage_usage(team_id) VALUES (ctx.team_id) ON CONFLICT (team_id) DO NOTHING;
  SELECT * INTO before_row FROM app.storage_usage u WHERE u.team_id = ctx.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settings rejected' USING ERRCODE = '42501';
  END IF;
  IF (before_row.max_bytes, before_row.max_files, before_row.upload_requests_per_minute)
     IS NOT DISTINCT FROM (limit_bytes, limit_files, upload_rate) THEN
    RETURN false;
  END IF;
  UPDATE app.storage_usage u SET max_bytes = limit_bytes, max_files = limit_files,
    upload_requests_per_minute = upload_rate, updated_at = clock_timestamp()
    WHERE u.team_id = ctx.team_id;
  INSERT INTO app.activity(team_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, ctx.actor_id, 'session', NULL, 'storage.settings_updated', 'storage-settings',
    'Updated CV storage settings',
    jsonb_build_object(
      'before', jsonb_build_object('maxBytes', before_row.max_bytes, 'maxFiles', before_row.max_files,
        'uploadRequestsPerMinute', before_row.upload_requests_per_minute),
      'after', jsonb_build_object('maxBytes', limit_bytes, 'maxFiles', limit_files,
        'uploadRequestsPerMinute', upload_rate)));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.set_storage_limits(bigint, integer, integer) FROM PUBLIC;

-- Frees the retained charge of one rejected Blob upload of the context's team after the application
-- deleted its object and confirmed it missing. Only once its last ticket expired at least 10 minutes
-- ago, so no valid ticket can recreate the object. Store, then team, then upload. Returns false and
-- changes nothing for any other upload, including one already released.
CREATE FUNCTION tenant_context.release_blob_charge(binding_store text, upload_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  target app.uploads%ROWTYPE;
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
  SELECT * INTO target FROM app.uploads x
    WHERE x.team_id = ctx.team_id AND x.id = upload_id AND x.storage_provider = 'blob'
      AND x.storage_store = binding_store AND x.status = 'rejected' AND x.blob_deleted_at IS NULL
      AND x.expires_at <= clock_timestamp() - interval '10 minutes'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE app.uploads x SET blob_deleted_at = clock_timestamp()
    WHERE x.team_id = ctx.team_id AND x.id = upload_id;
  UPDATE storage_ledger.stores s SET retained_bytes = s.retained_bytes - target.size_bytes,
    retained_files = s.retained_files - 1, updated_at = clock_timestamp()
    WHERE s.provider = 'blob' AND s.store = binding_store;
  UPDATE app.storage_usage u SET retained_bytes = u.retained_bytes - target.size_bytes,
    retained_files = u.retained_files - 1, updated_at = clock_timestamp()
    WHERE u.team_id = ctx.team_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.release_blob_charge(text, uuid) FROM PUBLIC;

-- Storage settings audit rows come only from the helper above; no runtime role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
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
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The code now depends on these columns and helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 3;
