-- Synthetic experiment only: not a migration, deployment component or production policy.
CREATE SCHEMA tenant_proof;
REVOKE ALL ON SCHEMA tenant_proof FROM PUBLIC;
CREATE TABLE tenant_proof.keys (id boolean PRIMARY KEY CHECK(id), secret bytea NOT NULL);
INSERT INTO tenant_proof.keys VALUES (true, convert_to('test-key-for-synthetic-proof-only','UTF8'));
CREATE TABLE tenant_proof.contexts (
  pid integer NOT NULL, xid xid8 NOT NULL, team text NOT NULL, actor text NOT NULL,
  can_read boolean NOT NULL, can_write boolean NOT NULL, expires_ms bigint NOT NULL,
  PRIMARY KEY (pid, xid)
);
CREATE TABLE tenant_proof.records (team_id text NOT NULL, body text NOT NULL);
INSERT INTO tenant_proof.records VALUES ('team-a','A'), ('team-b','B');
REVOKE ALL ON ALL TABLES IN SCHEMA tenant_proof FROM PUBLIC;
CREATE ROLE tenant_proof_runtime NOLOGIN;
GRANT USAGE ON SCHEMA tenant_proof TO tenant_proof_runtime;
GRANT SELECT, INSERT, UPDATE ON tenant_proof.records TO tenant_proof_runtime;

CREATE FUNCTION tenant_proof.install(payload text, signature text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE claim jsonb; now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF payload IS NULL OR length(payload)>2048 OR signature IS NULL OR signature !~ '^[0-9a-f]{64}$'
     OR encode(public.hmac(convert_to(payload,'UTF8'), (SELECT secret FROM tenant_proof.keys WHERE id=true), 'sha256'),'hex') IS DISTINCT FROM signature THEN
    RAISE EXCEPTION 'Invalid synthetic claim' USING ERRCODE='42501';
  END IF;
  claim := payload::jsonb;
  IF jsonb_typeof(claim)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(claim))<>8
     OR NOT (claim ?& ARRAY['aud','pid','xid','team','actor','read','write','exp'])
     OR claim->>'aud'<>'synthetic-proof'
     OR jsonb_typeof(claim->'pid')<>'number' OR (claim->>'pid')::integer<>pg_backend_pid()
     OR jsonb_typeof(claim->'xid')<>'string' OR claim->>'xid'<>pg_current_xact_id()::text
     OR jsonb_typeof(claim->'team')<>'string' OR length(claim->>'team') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(claim->'actor')<>'string' OR length(claim->>'actor') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(claim->'read')<>'boolean' OR jsonb_typeof(claim->'write')<>'boolean'
     OR jsonb_typeof(claim->'exp')<>'number' OR (claim->>'exp')::bigint<=now_ms OR (claim->>'exp')::bigint>now_ms+60000 THEN
    RAISE EXCEPTION 'Invalid synthetic claim' USING ERRCODE='42501';
  END IF;
  INSERT INTO tenant_proof.contexts(pid,xid,team,actor,can_read,can_write,expires_ms)
  VALUES(pg_backend_pid(),pg_current_xact_id(),claim->>'team',claim->>'actor',
    (claim->>'read')::boolean,(claim->>'write')::boolean,(claim->>'exp')::bigint);
END $$;

CREATE FUNCTION tenant_proof.allowed(row_team text, requested_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_proof.contexts c
    WHERE c.pid=pg_backend_pid() AND c.xid=pg_current_xact_id() AND c.team=row_team
      AND c.expires_ms > floor(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND CASE requested_action WHEN 'read' THEN c.can_read WHEN 'write' THEN c.can_write ELSE false END)
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tenant_proof FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_proof.install(text,text), tenant_proof.allowed(text,text) TO tenant_proof_runtime;
ALTER TABLE tenant_proof.records ENABLE ROW LEVEL SECURITY;
CREATE POLICY proof_read ON tenant_proof.records FOR SELECT USING (tenant_proof.allowed(team_id,'read'));
CREATE POLICY proof_insert ON tenant_proof.records FOR INSERT WITH CHECK (tenant_proof.allowed(team_id,'write'));
CREATE POLICY proof_update ON tenant_proof.records FOR UPDATE USING (tenant_proof.allowed(team_id,'write')) WITH CHECK (tenant_proof.allowed(team_id,'write'));
