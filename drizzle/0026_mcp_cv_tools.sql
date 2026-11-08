-- MCP tools for CV files (P1-17c, job 037). Apply after 0025_mcp_candidate_task_tools.sql, then rerun
-- infrastructure/postgres-split-runtime-roles.sql, which grants the data role the two new helpers
-- below. The storage schema marker goes to 6: the code reads the new storage_usage column, so startup
-- refuses a database without this migration.

-- As in 0025, only the body changes: the allowlist now holds exactly the 59 names of TOOLS in
-- src/lib/mcp/tools.ts, in the same order, and the two lists must stay the same. The signature,
-- owner, SECURITY DEFINER, search_path and execute rights are unchanged.
CREATE OR REPLACE FUNCTION tenant_context.audit_mcp_call(tool text, decision text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  client text;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'token';
  IF NOT FOUND OR tool IS NULL OR decision IS NULL
     OR tool NOT IN ('search_candidates', 'get_candidate', 'find_duplicate_candidates', 'create_candidate',
       'update_candidate', 'get_my_candidate_state', 'update_my_candidate_state',
       'get_cv_text', 'get_cv_texts', 'upload_cv', 'create_cv_upload_link', 'complete_cv_upload',
       'start_bulk_import', 'add_bulk_import_item', 'list_bulk_import_items', 'open_bulk_import_page',
       'list_job_roles', 'create_job_role', 'update_job_role',
       'list_vacancies', 'get_vacancy', 'create_vacancy', 'update_vacancy',
       'list_applications', 'get_application', 'create_application', 'bulk_create_applications',
       'update_application', 'move_application_stage',
       'list_interviews', 'schedule_interview', 'update_interview',
       'list_offers', 'create_offer', 'update_offer',
       'list_onboarding', 'create_onboarding', 'update_onboarding',
       'list_checklist_items', 'create_checklist_item', 'update_checklist_item',
       'list_tasks', 'create_task', 'update_task',
       'list_task_workflow_items', 'create_task_workflow_item', 'update_task_workflow_item',
       'list_saved_views', 'create_saved_view',
       'list_comments', 'add_comment', 'list_activity', 'list_notifications', 'mark_notifications_read',
       'get_overview', 'get_analytics', 'search_workspace',
       'archive_record', 'restore_record')
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

-- The team setting "Connected AI apps can read CV contents". A team without a row reads as on.
ALTER TABLE app.storage_usage ADD COLUMN mcp_cv_text_enabled boolean NOT NULL DEFAULT true;

-- Owner and admin sessions only, with the checks of set_storage_limits. Team and actor come from the
-- verified context. Writes one audit row when the value changes and returns whether it changed.
CREATE FUNCTION tenant_context.set_mcp_cv_text_access(enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  before_row app.storage_usage%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth.member m
       WHERE m.organization_id = ctx.team_id AND m.user_id = ctx.actor_id AND m.role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'Storage settings rejected' USING ERRCODE = '42501';
  END IF;
  IF enabled IS NULL THEN
    RAISE EXCEPTION 'Storage settings rejected' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.storage_usage(team_id) VALUES (ctx.team_id) ON CONFLICT (team_id) DO NOTHING;
  SELECT * INTO before_row FROM app.storage_usage u WHERE u.team_id = ctx.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settings rejected' USING ERRCODE = '42501';
  END IF;
  IF before_row.mcp_cv_text_enabled = enabled THEN
    RETURN false;
  END IF;
  UPDATE app.storage_usage u SET mcp_cv_text_enabled = enabled, updated_at = clock_timestamp()
    WHERE u.team_id = ctx.team_id;
  INSERT INTO app.activity(team_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, ctx.actor_id, 'session', NULL, 'storage.settings_updated', 'storage-settings',
    'Changed whether connected AI apps can read CV contents',
    jsonb_build_object('before', jsonb_build_object('mcpCvTextEnabled', before_row.mcp_cv_text_enabled),
      'after', jsonb_build_object('mcpCvTextEnabled', enabled)));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION tenant_context.set_mcp_cv_text_access(boolean) FROM PUBLIC;

-- Records one MCP read of a CV's text before any byte is read, and returns its candidate. Token
-- contexts with cvs:read and candidates:read only, for a ready, unerased upload of the context's team.
-- RQ003 when the team turned the setting off. Never stores a file name, text or arguments.
CREATE FUNCTION tenant_context.audit_mcp_cv_read(tool text, upload_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  target app.uploads%ROWTYPE;
  client text;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'token';
  IF NOT FOUND OR tool IS NULL OR upload_id IS NULL OR tool NOT IN ('get_cv_text', 'get_cv_texts')
     OR NOT ('cvs:read' = ANY(ctx.scopes) AND 'candidates:read' = ANY(ctx.scopes)) THEN
    RAISE EXCEPTION 'MCP CV read audit rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO target FROM app.uploads x
    WHERE x.team_id = ctx.team_id AND x.id = upload_id AND x.status = 'ready'
      AND x.erasure_id IS NULL AND x.candidate_id IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP CV read audit rejected' USING ERRCODE = '42501';
  END IF;
  SELECT t.oauth_client_id INTO client FROM auth.api_tokens t
    WHERE t.id = ctx.token_id AND t.team_id = ctx.team_id AND t.user_id = ctx.actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP CV read audit rejected' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM app.storage_usage u WHERE u.team_id = ctx.team_id AND NOT u.mcp_cv_text_enabled) THEN
    RAISE EXCEPTION 'CV text access is off for this team' USING ERRCODE = 'RQ003';
  END IF;
  INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, target.candidate_id, ctx.actor_id, 'token', ctx.token_id::uuid, 'mcp.cv_text_read', 'mcp-tool',
    'MCP tool ' || tool || ' read a CV''s text',
    jsonb_build_object('tool', tool, 'uploadId', upload_id, 'candidateId', target.candidate_id,
      'oauthClientId', client));
  RETURN target.candidate_id::text;
END $$;
REVOKE ALL ON FUNCTION tenant_context.audit_mcp_cv_read(text, uuid) FROM PUBLIC;

-- As in 0023, plus: the owner-only mcp-tool branch also admits mcp.cv_text_read, which only the helper
-- above writes. No runtime role inserts mcp-tool rows directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
    OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied', 'mcp.cv_text_read') AND tenant_context.allows(team_id, actor_id, 'read')
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

-- The code now depends on this column and these helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 6;
