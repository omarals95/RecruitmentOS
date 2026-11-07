-- A replayed authorization code or refresh token revokes its OAuth grant at the token endpoint,
-- which holds no tenant context. The owner-run helper below records that revocation; every value
-- except the fixed reason comes from the grant row.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (kind NOT IN ('api-token', 'mcp-tool') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
  OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied') AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'api-token' AND action = 'token.revoked' AND actor_type = 'token'
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- Owner-only read of revocation rows, so the helper's at-most-once check sees rows of every team
-- without a context. A runtime role is never the owner, so its access is unchanged.
CREATE POLICY revocation_owner_read ON app.activity FOR SELECT USING (
  kind = 'api-token' AND action = 'token.revoked'
  AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'));

-- One token.revoked row per grant, only for a grant revoked in this transaction after its code or
-- a refresh token was used, and only if no revocation row exists yet.
CREATE FUNCTION tenant_context.audit_grant_reuse(grant_id text, reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tok auth.api_tokens%ROWTYPE;
BEGIN
  IF reason IS NULL OR reason NOT IN ('authorization_code_reused', 'refresh_token_reused') THEN
    RAISE EXCEPTION 'Grant reuse audit rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO tok FROM auth.api_tokens t WHERE t.id = audit_grant_reuse.grant_id FOR UPDATE;
  IF NOT FOUND OR tok.oauth_client_id IS NULL OR tok.revoked_at IS DISTINCT FROM transaction_timestamp()
     OR (CASE reason
       WHEN 'authorization_code_reused' THEN EXISTS (SELECT 1 FROM auth.oauth_codes c
         WHERE c.grant_id = tok.id AND c.used_at IS NOT NULL)
       ELSE EXISTS (SELECT 1 FROM auth.oauth_tokens o
         WHERE o.grant_id = tok.id AND o.kind = 'refresh' AND o.used_at IS NOT NULL) END) IS NOT TRUE
     OR EXISTS (SELECT 1 FROM app.activity a WHERE a.kind = 'api-token' AND a.action = 'token.revoked'
       AND a.metadata->>'tokenId' = tok.id) THEN
    RAISE EXCEPTION 'Grant reuse audit rejected' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.activity(team_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (tok.team_id, tok.user_id, 'token', tok.id::uuid, 'token.revoked', 'api-token',
    'Revoked an OAuth connection after a reused credential',
    jsonb_build_object('tokenId', tok.id, 'prefix', tok.prefix, 'reason', reason));
END $$;
REVOKE ALL ON FUNCTION tenant_context.audit_grant_reuse(text, text) FROM PUBLIC;
