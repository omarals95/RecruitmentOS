-- Speed log: action and route timings only; no content, record ids, user ids or names. Kept 30 days.
CREATE TABLE app.speed_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id text NOT NULL REFERENCES auth.organization(id),
  kind text NOT NULL CHECK (kind IN ('action','route')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name ~ '^[A-Za-z0-9 ._/-]+$|^[A-Z]+ /api/v1(/([a-z][a-z-]{0,40}|\[id\]))*$'),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 600000),
  db_ms integer CHECK (db_ms IS NULL OR (db_ms BETWEEN 0 AND 600000 AND kind = 'route')),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('hour', now())
);
CREATE INDEX speed_samples_team_recorded_idx ON app.speed_samples(team_id, recorded_at);
ALTER TABLE app.speed_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.speed_samples FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.speed_samples FROM PUBLIC;
CREATE POLICY context_read ON app.speed_samples FOR SELECT USING (tenant_context.allows(team_id, NULL, 'read'));
CREATE POLICY context_insert ON app.speed_samples FOR INSERT WITH CHECK (tenant_context.allows(team_id, NULL, 'read') AND recorded_at = date_trunc('hour', now()));
CREATE POLICY context_delete ON app.speed_samples FOR DELETE USING (tenant_context.allows(team_id, NULL, 'read') AND recorded_at < now() - interval '30 days');
