-- MCP candidate, task and collaboration tools (P1-17b, job 036). The audit helper from 0010 refuses
-- any tool name not on its allowlist, and a tool whose audit row is refused does not run. As in 0024,
-- this replaces only the function body: the allowlist now holds exactly the 50 names of TOOLS in
-- src/lib/mcp/tools.ts, in the same order, and the two lists must stay the same. The signature,
-- owner, SECURITY DEFINER, search_path and execute rights are unchanged, so the runtime role template
-- does not change.
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
