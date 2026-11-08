-- An owner resets another member's two-step sign-in: the identity pool calls this owner-run helper
-- under a verified session context, and it writes the only audit row of kind account-security.

-- Owner sessions with two-step sign-in only. Team and actor come from the verified context; the
-- target must be another member of that team, in no team the actor does not own (RQ004), with
-- something to reset (RQ003 otherwise). In this transaction it removes the target's secret, backup
-- codes, sessions, trusted devices and pending challenges.
CREATE FUNCTION tenant_context.reset_two_step(target_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  target auth."user"%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth.member m JOIN auth."user" u ON u.id = m.user_id
       WHERE m.organization_id = ctx.team_id AND m.user_id = ctx.actor_id AND m.role = 'owner'
         AND u.two_factor_enabled) THEN
    RAISE EXCEPTION 'Two-step reset rejected' USING ERRCODE = '42501';
  END IF;
  IF target_user_id IS NULL OR target_user_id = ctx.actor_id OR NOT EXISTS (SELECT 1 FROM auth.member m
       WHERE m.organization_id = ctx.team_id AND m.user_id = target_user_id) THEN
    RAISE EXCEPTION 'Two-step reset rejected' USING ERRCODE = '42501';
  END IF;
  -- The reset is account-wide, so the actor must own every team the target belongs to (RQ004).
  IF EXISTS (SELECT 1 FROM auth.member t WHERE t.user_id = target_user_id AND NOT EXISTS (
       SELECT 1 FROM auth.member a WHERE a.organization_id = t.organization_id
         AND a.user_id = ctx.actor_id AND a.role = 'owner')) THEN
    RAISE EXCEPTION 'Two-step reset rejected' USING ERRCODE = 'RQ004';
  END IF;
  SELECT * INTO target FROM auth."user" u WHERE u.id = target_user_id FOR UPDATE;
  IF NOT target.two_factor_enabled AND NOT EXISTS (SELECT 1 FROM auth.two_factor t WHERE t.user_id = target.id) THEN
    RAISE EXCEPTION 'Two-step sign-in is not enabled' USING ERRCODE = 'RQ003';
  END IF;
  DELETE FROM auth.two_factor t WHERE t.user_id = target.id;
  UPDATE auth."user" u SET two_factor_enabled = false, updated_at = now() WHERE u.id = target.id;
  DELETE FROM auth.session s WHERE s.user_id = target.id;
  DELETE FROM auth.verification v
    WHERE (v.identifier LIKE 'trust-device-%' OR v.identifier LIKE '2fa-%') AND v.value = target.id;
  INSERT INTO app.activity(team_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, ctx.actor_id, 'session', NULL, 'two_step.reset', 'account-security',
    'Reset a member''s two-step sign-in', jsonb_build_object('targetUserId', target.id));
END $$;
REVOKE ALL ON FUNCTION tenant_context.reset_two_step(text) FROM PUBLIC;

-- As in 0021 (which carries the 0018 branches and the candidate-erasure branch), plus: account-security
-- rows come only from the owner (the helper above or the owner-run recovery script); no runtime
-- role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
    OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'api-token' AND action = 'token.revoked' AND actor_type = 'token'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'export' AND action = 'records.exported' AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'storage-settings' AND action = 'storage.settings_updated' AND actor_type = 'session'
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'account-security' AND action = 'two_step.reset' AND actor_type = 'session'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));
