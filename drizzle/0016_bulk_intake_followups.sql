-- Bulk intake follow-ups: the item's current CV upload attempt and the purge of expired recovery rows.

-- The clientUploadId of the item's current CV upload attempt; null means the item ID. The server
-- sets a new key only when the current attempt is rejected or expired.
ALTER TABLE app.bulk_intake_items ADD COLUMN upload_key uuid,
  ADD CONSTRAINT bulk_intake_items_upload_key_check CHECK (upload_key IS NULL OR candidate_id IS NOT NULL);

-- Owner-only access to every team's and user's recovery rows, so the purge helper can delete
-- expired batches across teams. A runtime role is never the owner, so its access is unchanged.
DO $owner_policies$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['bulk_intake_batches','bulk_intake_items'] LOOP
  EXECUTE format('CREATE POLICY ledger_owner_read ON app.%I FOR SELECT USING (%s)', tbl,
    'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')');
  EXECUTE format('CREATE POLICY ledger_owner_delete ON app.%I FOR DELETE USING (%s)', tbl,
    'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')');
 END LOOP;
END $owner_policies$;

-- Deletes up to 100 expired batches of any team and user, oldest expiry first, and their items.
-- Rows another transaction holds are skipped; keep_batch is left for its caller to refuse. It returns
-- nothing, so no other team's count is revealed. The caller needs a verified context with cvs:write.
CREATE FUNCTION tenant_context.purge_bulk_intake(keep_batch uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND 'cvs:write' = ANY(c.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bulk intake purge rejected' USING ERRCODE = '42501';
  END IF;
  DELETE FROM app.bulk_intake_batches b WHERE b.id IN (
    SELECT x.id FROM app.bulk_intake_batches x
      WHERE x.expires_at <= clock_timestamp() AND x.id IS DISTINCT FROM keep_batch
      ORDER BY x.expires_at, x.id
      LIMIT 100
      FOR UPDATE SKIP LOCKED);
END $$;
REVOKE ALL ON FUNCTION tenant_context.purge_bulk_intake(uuid) FROM PUBLIC;
