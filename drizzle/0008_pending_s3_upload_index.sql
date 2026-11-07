-- Serves the store-wide release of expired S3 reservations that lock_storage_allocation runs on
-- every reserve, complete and cleanup. An index does not change the storage schema marker.
CREATE INDEX uploads_pending_s3_expiry_idx ON app.uploads (storage_store, expires_at)
  WHERE storage_provider = 's3' AND status = 'pending';
