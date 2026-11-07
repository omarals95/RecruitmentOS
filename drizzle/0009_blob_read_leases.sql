-- Cross-instance limit on private Blob provider reads. A lease is a short committed row, not a lock
-- held through the read, so a crashed instance's slot frees itself when the lease expires.
CREATE TABLE storage_ledger.blob_read_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store text NOT NULL CHECK (store ~ '^store_[A-Za-z0-9]{1,128}$'),
  team_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX blob_read_leases_store_expiry_idx ON storage_ledger.blob_read_leases (store, expires_at);
REVOKE ALL ON storage_ledger.blob_read_leases FROM PUBLIC;

-- Locks the store row, so acquisitions on one store are serialized, then drops its expired leases.
-- The caps are fixed here, so a runtime caller cannot raise them. Over either cap it returns null.
-- The team comes from the verified context, never from an argument.
CREATE FUNCTION tenant_context.acquire_blob_read(binding_store text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  lease uuid;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.scopes && ARRAY['cvs:read','cvs:write'];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blob read rejected' USING ERRCODE = '42501';
  END IF;
  IF binding_store IS NULL OR binding_store !~ '^store_[A-Za-z0-9]{1,128}$' THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  PERFORM 1 FROM storage_ledger.stores s WHERE s.provider = 'blob' AND s.store = binding_store FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  DELETE FROM storage_ledger.blob_read_leases l WHERE l.store = binding_store AND l.expires_at <= clock_timestamp();
  IF (SELECT count(*) FROM storage_ledger.blob_read_leases l WHERE l.store = binding_store AND l.team_id = ctx.team_id) >= 2
     OR (SELECT count(*) FROM storage_ledger.blob_read_leases l WHERE l.store = binding_store) >= 8 THEN
    RETURN NULL;
  END IF;
  INSERT INTO storage_ledger.blob_read_leases(store, team_id, expires_at)
    VALUES (binding_store, ctx.team_id, clock_timestamp() + interval '30 seconds') RETURNING id INTO lease;
  RETURN lease;
END $$;

-- Releases only a lease of the context's team; any other id is left alone without an error.
CREATE FUNCTION tenant_context.release_blob_read(lease_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.scopes && ARRAY['cvs:read','cvs:write'];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blob read rejected' USING ERRCODE = '42501';
  END IF;
  DELETE FROM storage_ledger.blob_read_leases l WHERE l.id = lease_id AND l.team_id = ctx.team_id;
END $$;

-- The code now depends on these helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 2;

REVOKE ALL ON FUNCTION tenant_context.acquire_blob_read(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_context.release_blob_read(uuid) FROM PUBLIC;
