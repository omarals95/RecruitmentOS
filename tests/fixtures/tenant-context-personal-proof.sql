-- Synthetic RLS experiment only; never apply to an application database.
CREATE TABLE tenant_proof.personal_records (team_id text NOT NULL, owner_id text NOT NULL, body text NOT NULL);
INSERT INTO tenant_proof.personal_records VALUES
  ('team-a','actor-a','A-private'),
  ('team-a','actor-b','B-private'),
  ('team-b','actor-b','other-team'),
  ('team-b','actor-a','same-actor-other-team');
GRANT SELECT, INSERT, UPDATE ON tenant_proof.personal_records TO tenant_proof_runtime;
ALTER TABLE tenant_proof.personal_records ENABLE ROW LEVEL SECURITY;
-- The verified transaction context supplies the actor; caller-set GUCs are ignored.
CREATE FUNCTION tenant_proof.allowed_personal(row_team text, row_owner text, requested_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_proof.contexts c
    WHERE c.pid=pg_backend_pid() AND c.xid=pg_current_xact_id() AND c.team=row_team AND c.actor=row_owner
      AND c.expires_ms > floor(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND CASE requested_action WHEN 'read' THEN c.can_read WHEN 'write' THEN c.can_write ELSE false END)
$$;
REVOKE ALL ON FUNCTION tenant_proof.allowed_personal(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_proof.allowed_personal(text,text,text) TO tenant_proof_runtime;
CREATE POLICY personal_read ON tenant_proof.personal_records FOR SELECT USING (tenant_proof.allowed_personal(team_id,owner_id,'read'));
CREATE POLICY personal_insert ON tenant_proof.personal_records FOR INSERT WITH CHECK (tenant_proof.allowed_personal(team_id,owner_id,'write'));
CREATE POLICY personal_update ON tenant_proof.personal_records FOR UPDATE USING (tenant_proof.allowed_personal(team_id,owner_id,'write')) WITH CHECK (tenant_proof.allowed_personal(team_id,owner_id,'write'));
