-- Test-only, synthetic proof. This is not a production migration or implementation.
CREATE SCHEMA audit_proof;
REVOKE ALL ON SCHEMA audit_proof FROM PUBLIC;
CREATE TABLE audit_proof.keys (id boolean PRIMARY KEY CHECK(id), secret bytea NOT NULL);
INSERT INTO audit_proof.keys VALUES (true, convert_to('synthetic-audit-proof-key-only','UTF8'));
CREATE TABLE audit_proof.members (team text NOT NULL, actor text NOT NULL, active boolean NOT NULL, role text NOT NULL CHECK(role IN ('owner','admin','recruiter','viewer')), PRIMARY KEY(team,actor));
CREATE TABLE audit_proof.sessions (id text PRIMARY KEY, actor text NOT NULL, active boolean NOT NULL);
-- Test-only hook simulates time spent waiting on authorization locks.
CREATE TABLE audit_proof.test_delay (seconds double precision NOT NULL CHECK(seconds BETWEEN 0 AND 2));
INSERT INTO audit_proof.test_delay VALUES (0);
INSERT INTO audit_proof.members VALUES ('team-a','actor-a',true,'owner'), ('team-b','actor-b',true,'owner'), ('team-a','actor-c',true,'recruiter'), ('team-a','actor-d',true,'admin');
INSERT INTO audit_proof.sessions VALUES ('session-a','actor-a',true), ('session-b','actor-b',true), ('session-c','actor-c',true), ('session-d','actor-d',true);
CREATE TABLE audit_proof.tokens (id text PRIMARY KEY, team text NOT NULL, actor text NOT NULL, revoked boolean NOT NULL DEFAULT false);
CREATE TABLE audit_proof.events (request text PRIMARY KEY, team text NOT NULL, actor text NOT NULL, token text NOT NULL, action text NOT NULL CHECK(action IN ('create','revoke')));
REVOKE ALL ON ALL TABLES IN SCHEMA audit_proof FROM PUBLIC;
CREATE ROLE audit_proof_caller NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE audit_proof_data NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA audit_proof TO audit_proof_caller, audit_proof_data;

-- One synthetic owner-controlled function performs both writes, so neither can
-- commit without the other. The caller cannot supply free-form audit content.
CREATE FUNCTION audit_proof.change_token(payload text, signature text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE claim jsonb; now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint; was_revoked boolean; member_role text;
BEGIN
  IF payload IS NULL OR length(payload)>2048 OR signature IS NULL OR signature !~ '^[0-9a-f]{64}$'
     OR encode(public.hmac(convert_to(payload,'UTF8'), (SELECT secret FROM audit_proof.keys WHERE id=true), 'sha256'),'hex') IS DISTINCT FROM signature THEN
    RAISE EXCEPTION 'Invalid synthetic audit claim' USING ERRCODE='42501';
  END IF;
  claim := payload::jsonb;
  IF jsonb_typeof(claim)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(claim))<>11
     OR NOT (claim ?& ARRAY['aud','pid','xid','team','actor','session','operation','token','request','scope','exp'])
     OR jsonb_typeof(claim->'aud')<>'string' OR claim->>'aud'<>'synthetic-audit-proof'
     OR jsonb_typeof(claim->'pid')<>'number' OR (claim->>'pid')::integer<>pg_backend_pid()
     OR jsonb_typeof(claim->'xid')<>'string' OR claim->>'xid'<>pg_current_xact_id()::text
     OR jsonb_typeof(claim->'team')<>'string' OR claim->>'team' !~ '^[a-z0-9-]{1,64}$'
     OR jsonb_typeof(claim->'actor')<>'string' OR claim->>'actor' !~ '^[a-z0-9-]{1,64}$'
     OR jsonb_typeof(claim->'session')<>'string' OR claim->>'session' !~ '^[a-z0-9-]{1,64}$'
     OR jsonb_typeof(claim->'token')<>'string' OR claim->>'token' !~ '^[a-z0-9-]{1,64}$'
     OR jsonb_typeof(claim->'request')<>'string' OR claim->>'request' !~ '^[a-z0-9-]{1,64}$'
     OR jsonb_typeof(claim->'operation')<>'string' OR claim->>'operation' NOT IN ('create','revoke')
     OR jsonb_typeof(claim->'scope')<>'string' OR claim->>'scope'<>'token:manage'
     OR jsonb_typeof(claim->'exp')<>'number' OR (claim->>'exp')::bigint<=now_ms OR (claim->>'exp')::bigint>now_ms+60000 THEN
    RAISE EXCEPTION 'Invalid synthetic audit claim' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM audit_proof.sessions s WHERE s.id=claim->>'session' AND s.actor=claim->>'actor' AND s.active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Synthetic session unavailable' USING ERRCODE='42501'; END IF;
  SELECT m.role INTO member_role FROM audit_proof.members m WHERE m.team=claim->>'team' AND m.actor=claim->>'actor' AND m.active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Synthetic membership unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_sleep((SELECT seconds FROM audit_proof.test_delay));
  IF (claim->>'exp')::bigint <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'Synthetic claim expired after authorization' USING ERRCODE='42501';
  END IF;
  IF claim->>'operation'='create' THEN
    INSERT INTO audit_proof.tokens(id,team,actor) VALUES(claim->>'token',claim->>'team',claim->>'actor');
  ELSE
    SELECT revoked INTO was_revoked FROM audit_proof.tokens t
      WHERE t.id=claim->>'token' AND t.team=claim->>'team' AND (t.actor=claim->>'actor' OR member_role IN ('owner','admin')) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Synthetic token unavailable' USING ERRCODE='42501'; END IF;
    IF (claim->>'exp')::bigint <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
      RAISE EXCEPTION 'Synthetic claim expired after authorization' USING ERRCODE='42501';
    END IF;
    IF was_revoked THEN RETURN false; END IF;
    UPDATE audit_proof.tokens SET revoked=true WHERE id=claim->>'token';
  END IF;
  IF (claim->>'exp')::bigint <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'Synthetic claim expired after authorization' USING ERRCODE='42501';
  END IF;
  INSERT INTO audit_proof.events(request,team,actor,token,action)
    VALUES(claim->>'request',claim->>'team',claim->>'actor',claim->>'token',claim->>'operation');
  IF (claim->>'exp')::bigint <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'Synthetic claim expired after authorization' USING ERRCODE='42501';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION audit_proof.change_token(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_proof.change_token(text,text) TO audit_proof_caller;
