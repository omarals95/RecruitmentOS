-- Bulk intake tombstones: a purged batch keeps its row, so its client-chosen ID is refused and never
-- recreated by a late retry. The row keeps only its ID, team, creator and timestamps; its items, with
-- their file metadata, hashes and review evidence, are deleted.

-- Set once, by the purge helper, when the batch's items are deleted.
ALTER TABLE app.bulk_intake_batches ADD COLUMN purged_at timestamptz;
-- The purge scans only batches it has not purged yet, so its cost does not grow with tombstones.
CREATE INDEX bulk_intake_batches_purge_idx ON app.bulk_intake_batches(expires_at, id) WHERE purged_at IS NULL;

-- Marks up to 100 expired, unpurged batches of any team and user as purged, oldest expiry first, and
-- deletes their items. Rows another transaction holds are skipped; keep_batch is left for its caller
-- to refuse. It returns nothing, so no other team's count is revealed. The caller needs a verified
-- context with cvs:write. The update and delete use the owner-only policies from 0016.
CREATE OR REPLACE FUNCTION tenant_context.purge_bulk_intake(keep_batch uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND 'cvs:write' = ANY(c.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bulk intake purge rejected' USING ERRCODE = '42501';
  END IF;
  WITH purged AS (
    UPDATE app.bulk_intake_batches b SET purged_at = clock_timestamp() WHERE b.id IN (
      SELECT x.id FROM app.bulk_intake_batches x
        WHERE x.purged_at IS NULL AND x.expires_at <= clock_timestamp()
          AND x.id IS DISTINCT FROM keep_batch
        ORDER BY x.expires_at, x.id
        LIMIT 100
        FOR UPDATE SKIP LOCKED)
    RETURNING b.team_id, b.id, b.created_by)
  DELETE FROM app.bulk_intake_items i USING purged p
    WHERE i.team_id = p.team_id AND i.batch_id = p.id AND i.created_by = p.created_by;
END $$;
REVOKE ALL ON FUNCTION tenant_context.purge_bulk_intake(uuid) FROM PUBLIC;
