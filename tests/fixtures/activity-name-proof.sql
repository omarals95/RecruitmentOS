-- Synthetic test fixture only; no production schema or trigger changes.
-- It inherits the unresolved replay/revocation limits of tenant-context-proof.sql.
ALTER TABLE tenant_proof.contexts ADD COLUMN can_candidates boolean NOT NULL DEFAULT false;
CREATE TABLE tenant_proof.identities (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE tenant_proof.activity (
  id integer PRIMARY KEY, team_id text NOT NULL, actor_id text NOT NULL,
  action text NOT NULL, kind text NOT NULL, summary text NOT NULL, created_at integer NOT NULL
);
INSERT INTO tenant_proof.identities VALUES
 ('former','Historical Actor'), ('actor-a','Current Actor'), ('actor-b','Other Actor');
-- The former actor is deliberately not required to retain team membership.
INSERT INTO tenant_proof.activity VALUES
 (1,'team-a','former','created','cv','Earlier event',1),
 (2,'team-a','former','created','cv','Later event',2),
 (3,'team-b','former','created','cv','Foreign event',3),
 (4,'team-a','actor-b','personal_state_updated','cv','Private event',4),
 (5,'team-a','actor-b','created','saved-view','Private view',5),
 (6,'team-a','actor-b','created','candidate','Candidate event',6),
 (7,'team-a','actor-a','personal_state_updated','cv','Own event',7),
 (8,'team-a','actor-b','created','cv','Other event',8);
REVOKE ALL ON tenant_proof.identities, tenant_proof.activity FROM PUBLIC;

CREATE FUNCTION tenant_proof.install_activity(payload text, signature text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claim jsonb; now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF payload IS NULL OR length(payload)>2048 OR signature IS NULL OR signature !~ '^[0-9a-f]{64}$'
     OR encode(public.hmac(convert_to(payload,'UTF8'),(SELECT secret FROM tenant_proof.keys WHERE id=true),'sha256'),'hex') IS DISTINCT FROM signature THEN
    RAISE EXCEPTION 'Invalid synthetic claim' USING ERRCODE='42501';
  END IF;
  claim := payload::jsonb;
  IF jsonb_typeof(claim)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(claim))<>8
     OR NOT (claim ?& ARRAY['aud','pid','xid','team','actor','read','candidates','exp'])
     OR claim->>'aud'<>'synthetic-activity'
     OR jsonb_typeof(claim->'pid')<>'number' OR (claim->>'pid')::integer<>pg_backend_pid()
     OR jsonb_typeof(claim->'xid')<>'string' OR claim->>'xid'<>pg_current_xact_id()::text
     OR jsonb_typeof(claim->'team')<>'string' OR length(claim->>'team') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(claim->'actor')<>'string' OR length(claim->>'actor') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(claim->'read')<>'boolean' OR jsonb_typeof(claim->'candidates')<>'boolean'
     OR jsonb_typeof(claim->'exp')<>'number' OR (claim->>'exp')::bigint<=now_ms OR (claim->>'exp')::bigint>now_ms+60000 THEN
    RAISE EXCEPTION 'Invalid synthetic claim' USING ERRCODE='42501';
  END IF;
  INSERT INTO tenant_proof.contexts(pid,xid,team,actor,can_read,can_write,expires_ms,can_candidates)
  VALUES(pg_backend_pid(),pg_current_xact_id(),claim->>'team',claim->>'actor',
    (claim->>'read')::boolean,false,(claim->>'exp')::bigint,(claim->>'candidates')::boolean);
END $$;

CREATE FUNCTION tenant_proof.activity_visible(row_team text, row_actor text, row_action text, row_kind text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_proof.contexts c
    WHERE c.pid=pg_backend_pid() AND c.xid=pg_current_xact_id() AND c.team=row_team AND c.can_read
      AND c.expires_ms>floor(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND (row_action<>'personal_state_updated' OR row_actor=c.actor)
      AND (row_kind<>'saved-view' OR row_actor=c.actor)
      AND (row_kind<>'candidate' OR c.can_candidates))
$$;

-- Resolve only through the actual visible event, never a caller-selected actor/team pair.
CREATE FUNCTION tenant_proof.activity_actor_name(event_id integer) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT i.name FROM tenant_proof.activity a
  LEFT JOIN tenant_proof.identities i ON i.id=a.actor_id
  WHERE a.id=event_id AND tenant_proof.activity_visible(a.team_id,a.actor_id,a.action,a.kind)
$$;
REVOKE ALL ON FUNCTION tenant_proof.install_activity(text,text),tenant_proof.activity_visible(text,text,text,text),tenant_proof.activity_actor_name(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_proof.install_activity(text,text),tenant_proof.activity_visible(text,text,text,text),tenant_proof.activity_actor_name(integer) TO tenant_proof_runtime;
GRANT SELECT ON tenant_proof.activity TO tenant_proof_runtime;
ALTER TABLE tenant_proof.activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_read ON tenant_proof.activity FOR SELECT
USING (tenant_proof.activity_visible(team_id,actor_id,action,kind));
