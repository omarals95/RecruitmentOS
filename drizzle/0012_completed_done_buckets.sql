-- Task completion is an explicit bucket flag. Teams set up before the flag existed have an unflagged
-- "Done" bucket from bootstrapTeam; flag only buckets named Done that carry no flag yet, so an admin's
-- explicit choice is never overwritten. The version bump makes an editor opened earlier refuse a stale save.
-- The owner is subject to FORCE RLS; lift it only for this backfill inside the migration transaction.
ALTER TABLE app.records NO FORCE ROW LEVEL SECURITY;
UPDATE app.records SET data = data || '{"completed": true}'::jsonb, version = version + 1, updated_at = now()
  WHERE kind = 'bucket' AND lower(btrim(data->>'name')) = 'done' AND NOT (data ? 'completed');
ALTER TABLE app.records FORCE ROW LEVEL SECURITY;
