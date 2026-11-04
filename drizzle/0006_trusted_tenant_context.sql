-- Signed per-transaction tenant context. Policies derive team, actor and access from an
-- owner-verified assertion bound to this backend and transaction, never from settings.
CREATE SCHEMA tenant_context;
REVOKE ALL ON SCHEMA tenant_context FROM PUBLIC;

-- HMAC-SHA256 pads derived from TENANT_CONTEXT_SIGNING_KEY; the key itself is never stored.
CREATE TABLE tenant_context.keys (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
  inner_pad bytea NOT NULL CHECK (octet_length(inner_pad) = 64),
  outer_pad bytea NOT NULL CHECK (octet_length(outer_pad) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE TABLE tenant_context.contexts (
  pid integer NOT NULL,
  xid xid8 NOT NULL,
  team_id text NOT NULL,
  actor_id text NOT NULL,
  auth_type text NOT NULL CHECK (auth_type IN ('session','token')),
  token_id text,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (pid, xid)
);
CREATE INDEX contexts_expires_idx ON tenant_context.contexts(expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA tenant_context FROM PUBLIC;

-- Every rejection uses one generic error; the payload, signature and pads never appear in it.
CREATE FUNCTION tenant_context.install(payload text, signature text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  known constant text[] := ARRAY['candidates:read','candidates:write','recruitment:read','recruitment:write','cvs:read','cvs:write','imports:write'];
  claim jsonb;
  pads record;
  asserted text[];
  now_ms bigint;
  member_role text;
  valid boolean;
BEGIN
  IF payload IS NULL OR signature IS NULL OR octet_length(payload) > 2048
     OR payload !~ '^[ -~]*$' OR strpos(payload, chr(92)) > 0 OR signature !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  BEGIN
    claim := payload::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END;
  IF jsonb_typeof(claim) IS DISTINCT FROM 'object' OR jsonb_typeof(claim->'kid') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  -- Verify the signature with a known, unretired key before any identity state is read.
  SELECT k.inner_pad, k.outer_pad INTO pads FROM tenant_context.keys k
    WHERE k.id = claim->>'kid' AND k.retired_at IS NULL;
  IF NOT FOUND OR encode(sha256(pads.outer_pad || sha256(pads.inner_pad || convert_to(payload, 'UTF8'))), 'hex') <> signature THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(claim->'scopes') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(claim->'scopes') e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  asserted := ARRAY(SELECT jsonb_array_elements_text(claim->'scopes'));
  now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  -- Rebuilding the canonical text enforces the exact field set, order and encoding.
  valid := jsonb_typeof(claim->'aud') = 'string' AND claim->>'aud' = 'recruitmentos-tenant-context-v1'
    AND jsonb_typeof(claim->'env') = 'string' AND claim->>'env' = (SELECT m.id::text FROM db_boundary.connection_marker m)
    AND jsonb_typeof(claim->'pid') = 'number' AND claim->>'pid' ~ '^[0-9]{1,10}$' AND (claim->>'pid')::bigint = pg_backend_pid()
    AND jsonb_typeof(claim->'xid') = 'string' AND claim->>'xid' = pg_current_xact_id()::text
    AND jsonb_typeof(claim->'team') = 'string' AND claim->>'team' ~ '^[A-Za-z0-9_.:@-]{1,128}$'
    AND jsonb_typeof(claim->'actor') = 'string' AND claim->>'actor' ~ '^[A-Za-z0-9_.:@-]{1,128}$'
    AND jsonb_typeof(claim->'auth') = 'string' AND claim->>'auth' IN ('session','token')
    AND CASE claim->>'auth'
      WHEN 'session' THEN jsonb_typeof(claim->'token') = 'null'
      ELSE jsonb_typeof(claim->'token') = 'string' AND claim->>'token' ~ '^[A-Za-z0-9_.:@-]{1,128}$' END
    AND asserted = ARRAY(SELECT s FROM unnest(known) WITH ORDINALITY AS k(s, n) WHERE s = ANY(asserted) ORDER BY n)
    AND jsonb_typeof(claim->'exp') = 'number' AND claim->>'exp' ~ '^[0-9]{1,15}$'
    AND (claim->>'exp')::bigint > now_ms AND (claim->>'exp')::bigint <= now_ms + 60000
    AND payload = '{"aud":' || to_json(claim->>'aud')::text || ',"kid":' || to_json(claim->>'kid')::text
      || ',"env":' || to_json(claim->>'env')::text || ',"pid":' || (claim->>'pid')
      || ',"xid":' || to_json(claim->>'xid')::text || ',"team":' || to_json(claim->>'team')::text
      || ',"actor":' || to_json(claim->>'actor')::text || ',"auth":' || to_json(claim->>'auth')::text
      || ',"token":' || coalesce(to_json(claim->>'token')::text, 'null')
      || ',"scopes":' || coalesce((SELECT '[' || string_agg(to_json(s)::text, ',' ORDER BY n) || ']' FROM unnest(asserted) WITH ORDINALITY AS a(s, n)), '[]')
      || ',"exp":' || (claim->>'exp') || '}'
    AND NOT EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id());
  IF valid IS NOT TRUE THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  -- Recheck current identity state; revocations committed after this take effect next transaction.
  SELECT m.role INTO member_role FROM auth."user" u
    JOIN auth.member m ON m.user_id = u.id
    WHERE u.id = claim->>'actor' AND m.organization_id = claim->>'team' AND u.email_verified
    FOR SHARE;
  IF NOT FOUND OR (asserted <@ CASE member_role
      WHEN 'owner' THEN known WHEN 'admin' THEN known WHEN 'recruiter' THEN known[1:6]
      WHEN 'viewer' THEN ARRAY['candidates:read','recruitment:read','cvs:read'] END) IS NOT TRUE THEN
    RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
  END IF;
  IF claim->>'auth' = 'token' THEN
    PERFORM 1 FROM auth.api_tokens t
      WHERE t.id = claim->>'token' AND t.user_id = claim->>'actor' AND t.team_id = claim->>'team'
        AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()
        AND asserted <@ ARRAY(SELECT jsonb_array_elements_text(t.scopes))
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tenant context rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- Bounded purge: committed contexts are never matched again because an xid8 is never reused.
  DELETE FROM tenant_context.contexts c WHERE (c.pid, c.xid) IN (
    SELECT o.pid, o.xid FROM tenant_context.contexts o WHERE o.expires_at <= clock_timestamp()
    ORDER BY o.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
  INSERT INTO tenant_context.contexts(pid, xid, team_id, actor_id, auth_type, token_id, scopes, expires_at)
  VALUES (pg_backend_pid(), pg_current_xact_id(), claim->>'team', claim->>'actor', claim->>'auth',
    claim->>'token', asserted, to_timestamp((claim->>'exp')::bigint / 1000.0));
END $$;

-- Policy predicates. A null owner means a shared row; write needs any write scope.
CREATE FUNCTION tenant_context.allows(row_team text, row_owner text, access text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.team_id = row_team
      AND (row_owner IS NULL OR c.actor_id = row_owner)
      AND CASE access WHEN 'read' THEN true
        WHEN 'write' THEN c.scopes && ARRAY['candidates:write','recruitment:write','cvs:write','imports:write']
        ELSE false END)
$$;
CREATE FUNCTION tenant_context.allows_activity(row_team text, row_actor text, row_action text, row_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.team_id = row_team
      AND (row_action <> 'personal_state_updated' OR c.actor_id = row_actor)
      AND (row_kind <> 'saved-view' OR c.actor_id = row_actor)
      AND (row_kind <> 'candidate' OR 'candidates:read' = ANY(c.scopes)))
$$;

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['records','candidate_states','activity','uploads','storage_usage','idempotency','notification_reads'] LOOP
  EXECUTE format('DROP POLICY team_isolation ON app.%I', tbl);
 END LOOP;
END $$;
DROP POLICY personal_state ON app.candidate_states;
DROP POLICY personal_notifications ON app.notification_reads;
DROP POLICY private_views ON app.records;

-- Token audit rows may also be inserted by the owner-run audit helper under a verified context.
DO $$ DECLARE spec text[]; BEGIN
 FOREACH spec SLICE 1 IN ARRAY ARRAY[
  ['records', 'tenant_context.allows(team_id, private_owner_id, ''read'')', 'tenant_context.allows(team_id, private_owner_id, ''write'')', 'tenant_context.allows(team_id, private_owner_id, ''write'')'],
  ['candidate_states', 'tenant_context.allows(team_id, user_id, ''read'')', 'tenant_context.allows(team_id, user_id, ''write'')', 'tenant_context.allows(team_id, user_id, ''write'')'],
  ['activity', 'tenant_context.allows_activity(team_id, actor_id, action, kind)', 'tenant_context.allows(team_id, NULL, ''write'')',
   'tenant_context.allows(team_id, NULL, ''write'') OR (kind = ''api-token'' AND action IN (''token.created'', ''token.revoked'') AND tenant_context.allows(team_id, actor_id, ''read'') AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context''))'],
  ['uploads', 'tenant_context.allows(team_id, NULL, ''read'')', 'tenant_context.allows(team_id, NULL, ''write'')', 'tenant_context.allows(team_id, NULL, ''write'')'],
  ['storage_usage', 'tenant_context.allows(team_id, NULL, ''read'')', 'tenant_context.allows(team_id, NULL, ''write'')', 'tenant_context.allows(team_id, NULL, ''write'')'],
  ['idempotency', 'tenant_context.allows(team_id, NULL, ''read'')', 'tenant_context.allows(team_id, NULL, ''write'')', 'tenant_context.allows(team_id, NULL, ''write'')'],
  ['notification_reads', 'tenant_context.allows(team_id, user_id, ''read'')', 'tenant_context.allows(team_id, user_id, ''read'')', 'tenant_context.allows(team_id, user_id, ''read'')']
 ] LOOP
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (%s)', spec[1], spec[2]);
  EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', spec[1], spec[4]);
  EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', spec[1], spec[3], spec[3]);
  EXECUTE format('CREATE POLICY context_delete ON app.%I FOR DELETE USING (%s)', spec[1], spec[3]);
 END LOOP;
END $$;

-- Resolves a name only for an event the current context may read; former members still resolve.
CREATE FUNCTION tenant_context.activity_actor_name(event_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT u.name FROM app.activity a JOIN auth."user" u ON u.id = a.actor_id
  WHERE a.id = event_id AND tenant_context.allows_activity(a.team_id, a.actor_id, a.action, a.kind)
$$;

-- Identity-side token audit in the caller's transaction; content comes from the token row.
CREATE FUNCTION tenant_context.audit_token(token_id text, event text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  tok auth.api_tokens%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Token audit rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO tok FROM auth.api_tokens t WHERE t.id = token_id AND t.team_id = ctx.team_id FOR UPDATE;
  IF NOT FOUND OR (CASE event
      WHEN 'token.created' THEN tok.revoked_at IS NULL AND tok.user_id = ctx.actor_id
      WHEN 'token.revoked' THEN tok.revoked_at IS NOT NULL AND (tok.user_id = ctx.actor_id OR EXISTS (
        SELECT 1 FROM auth.member m WHERE m.organization_id = tok.team_id AND m.user_id = ctx.actor_id AND m.role IN ('owner','admin')))
      ELSE false END) IS NOT TRUE
     OR EXISTS (SELECT 1 FROM app.activity a WHERE a.team_id = tok.team_id AND a.kind = 'api-token'
       AND a.action = event AND a.metadata->>'tokenId' = tok.id) THEN
    RAISE EXCEPTION 'Token audit rejected' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata)
  VALUES (tok.team_id, ctx.actor_id, 'session', event, 'api-token',
    CASE event WHEN 'token.created' THEN 'Created an API token' ELSE 'Revoked an API token' END,
    CASE event WHEN 'token.created' THEN jsonb_build_object('tokenId', tok.id, 'prefix', tok.prefix, 'scopes', tok.scopes)
      ELSE jsonb_build_object('tokenId', tok.id, 'prefix', tok.prefix) END);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tenant_context FROM PUBLIC;
