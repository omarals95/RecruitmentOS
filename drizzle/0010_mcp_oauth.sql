-- Minimal OAuth 2.1 authorization server for the MCP endpoint. An approved grant is an
-- auth.api_tokens row with oauth_client_id set, so revocation, the Settings list, the active-token
-- cap, current-role scope intersection and tenant_context.install apply to it unchanged.
-- Only SHA-256 hashes of codes and tokens are stored.
CREATE TABLE auth.oauth_clients (
  id text PRIMARY KEY CHECK (id ~ '^ros_client_[A-Za-z0-9_-]{22}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  redirect_uris jsonb NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array'
    AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE auth.api_tokens ADD COLUMN oauth_client_id text REFERENCES auth.oauth_clients(id);
CREATE TABLE auth.oauth_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  grant_id text NOT NULL REFERENCES auth.api_tokens(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES auth.oauth_clients(id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_oauth_codes_grant_idx ON auth.oauth_codes(grant_id);
CREATE TABLE auth.oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id text NOT NULL REFERENCES auth.api_tokens(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  audience text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_oauth_tokens_grant_idx ON auth.oauth_tokens(grant_id);
REVOKE ALL ON auth.oauth_clients, auth.oauth_codes, auth.oauth_tokens FROM PUBLIC;

-- MCP tool audit rows come only from the owner-run helper; no runtime role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (kind NOT IN ('api-token', 'mcp-tool') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
  OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied') AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- One audit row per MCP tools/call, written before the tool runs. Actor, team and token come from
-- the verified token context, the OAuth client from its grant row; arguments and results never.
-- Any context scopes are accepted, so read-only tokens are audited too.
CREATE FUNCTION tenant_context.audit_mcp_call(tool text, decision text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  client text;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'token';
  IF NOT FOUND OR tool IS NULL OR decision IS NULL
     OR tool NOT IN ('search_candidates', 'get_candidate', 'list_vacancies', 'get_vacancy', 'list_applications',
       'list_tasks', 'list_interviews', 'get_overview', 'create_candidate', 'add_comment')
     OR decision NOT IN ('allowed', 'denied') THEN
    RAISE EXCEPTION 'MCP audit rejected' USING ERRCODE = '42501';
  END IF;
  SELECT t.oauth_client_id INTO client FROM auth.api_tokens t
    WHERE t.id = ctx.token_id AND t.team_id = ctx.team_id AND t.user_id = ctx.actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP audit rejected' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.activity(team_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, ctx.actor_id, 'token', ctx.token_id::uuid,
    CASE decision WHEN 'allowed' THEN 'mcp.tool_called' ELSE 'mcp.tool_denied' END, 'mcp-tool',
    CASE decision WHEN 'allowed' THEN 'MCP tool ' || tool ELSE 'MCP tool ' || tool || ' denied' END,
    jsonb_build_object('tool', tool, 'oauthClientId', client));
END $$;
REVOKE ALL ON FUNCTION tenant_context.audit_mcp_call(text, text) FROM PUBLIC;
