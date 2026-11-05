-- Candidate review status is now one of two values, "Needs review" or "Reviewed". Saves re-parse the
-- whole stored record, so a candidate or saved view still holding other free text could no longer be
-- edited. Map it the way Source review already classifies it: the reviewed words (any case, outer
-- spaces ignored) become "Reviewed"; anything else, blank or missing, "Needs review". Saved views with
-- an empty review filter, values already controlled and rawSource (the original source text) stay as
-- they are. The version bump makes an editor opened earlier refuse a stale save.
-- The owner is subject to FORCE RLS; lift it only for this backfill inside the migration transaction.
ALTER TABLE app.records NO FORCE ROW LEVEL SECURITY;
UPDATE app.records SET data = jsonb_set(data, '{reviewStatus}', to_jsonb(CASE
    WHEN data->>'reviewStatus' ~* '^\s*(verified|reviewed|complete|completed)\s*$' THEN 'Reviewed'
    ELSE 'Needs review' END)), version = version + 1, updated_at = now()
  WHERE kind = 'candidate' AND (data->>'reviewStatus') IS DISTINCT FROM 'Needs review'
    AND (data->>'reviewStatus') IS DISTINCT FROM 'Reviewed';
UPDATE app.records SET data = jsonb_set(data, '{query,reviewStatus}', to_jsonb(CASE
    WHEN data#>>'{query,reviewStatus}' ~* '^\s*(verified|reviewed|complete|completed)\s*$' THEN 'Reviewed'
    ELSE 'Needs review' END)), version = version + 1
  WHERE kind = 'saved-view' AND coalesce(data#>>'{query,reviewStatus}', '') <> ''
    AND data#>>'{query,reviewStatus}' NOT IN ('Needs review', 'Reviewed');
ALTER TABLE app.records FORCE ROW LEVEL SECURITY;
