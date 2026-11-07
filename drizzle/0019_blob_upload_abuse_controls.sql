-- A per-reservation Blob PUT ticket count and a cross-instance per-team cleanup cooldown.
-- Budgets, team limits and the upload rate are unchanged; both stay off by default.

-- Counts every PUT ticket issued for a Blob reservation, the first one included. The cap is 5.
ALTER TABLE app.uploads
  ADD COLUMN put_tickets_issued integer NOT NULL DEFAULT 0
    CHECK (put_tickets_issued BETWEEN 0 AND 5);

-- As in 0018, plus: put_tickets_issued only grows by exactly 1, on a pending Blob row that stays pending.
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

-- The last cleanup claim per store and team. Owner-only: neither runtime role can read or write it.
CREATE TABLE storage_ledger.blob_reconciliation_claims (
  store text NOT NULL CHECK (store ~ '^store_[A-Za-z0-9]{1,128}$'),
  team_id text NOT NULL,
  claimed_at timestamptz NOT NULL,
  PRIMARY KEY (store, team_id)
);
REVOKE ALL ON storage_ledger.blob_reconciliation_claims FROM PUBLIC;

-- Claims one cleanup sweep of the context's team on this store, at most once per 10 minutes across
-- every instance and trigger. Returns 0 when claimed, otherwise the whole seconds left (1 to 600).
-- The team comes from the verified context, never from an argument.
CREATE FUNCTION tenant_context.claim_blob_reconciliation(binding_store text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  previous timestamptz;
  remaining integer;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND 'cvs:write' = ANY(c.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blob cleanup claim rejected' USING ERRCODE = '42501';
  END IF;
  IF binding_store IS NULL OR binding_store !~ '^store_[A-Za-z0-9]{1,128}$' THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  INSERT INTO storage_ledger.blob_reconciliation_claims(store, team_id, claimed_at)
    VALUES (binding_store, ctx.team_id, clock_timestamp())
    ON CONFLICT (store, team_id) DO NOTHING;
  IF FOUND THEN
    RETURN 0;
  END IF;
  SELECT r.claimed_at INTO previous FROM storage_ledger.blob_reconciliation_claims r
    WHERE r.store = binding_store AND r.team_id = ctx.team_id FOR UPDATE;
  remaining := ceil(extract(epoch FROM previous + interval '10 minutes' - clock_timestamp()))::integer;
  IF remaining > 0 THEN
    RETURN least(remaining, 600);
  END IF;
  UPDATE storage_ledger.blob_reconciliation_claims r SET claimed_at = clock_timestamp()
    WHERE r.store = binding_store AND r.team_id = ctx.team_id;
  RETURN 0;
END $$;
REVOKE ALL ON FUNCTION tenant_context.claim_blob_reconciliation(text) FROM PUBLIC;

-- The code now depends on this column and helper; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 4;
