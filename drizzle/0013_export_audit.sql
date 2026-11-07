-- Record exports are audited by an owner-run helper. The general insert branch needs a write scope,
-- which viewers and read-only tokens do not hold, yet they can export; the helper records every
-- reader. Team, actor, auth type and token come from the verified context; the caller gives only
-- the list, the row count and the filter keys. Filter values, search text and row IDs are never stored.
CREATE FUNCTION tenant_context.audit_export(resource text, row_count integer, filter_keys text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  keys text[];
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND OR resource IS NULL OR row_count IS NULL OR filter_keys IS NULL
     OR resource NOT IN ('candidates', 'job-roles', 'vacancies', 'applications', 'tasks', 'interviews', 'offers', 'onboarding')
     OR NOT (CASE resource WHEN 'candidates' THEN 'candidates:read' ELSE 'recruitment:read' END) = ANY(ctx.scopes)
     OR row_count NOT BETWEEN 0 AND 100000
     OR cardinality(filter_keys) > 40
     OR EXISTS (SELECT 1 FROM unnest(filter_keys) AS f(k) WHERE f.k IS NULL OR f.k NOT IN (
       'search', 'includeArchived', 'archived', 'legacyId', 'shortlisted', 'needsReview', 'categories',
       'skills', 'certifications', 'education', 'minYearsExperience', 'maxYearsExperience', 'startFrom',
       'startTo', 'candidateId', 'vacancyId', 'applicationId', 'onboardingId', 'bucketId', 'jobRoleId',
       'parentRecordId', 'applicationCandidateId', 'status', 'stage', 'department', 'residenceEmirate',
       'folderCategory', 'owner', 'priority', 'type', 'category', 'reviewStatus', 'degreeLevel',
       'employmentType', 'workMode', 'area')) THEN
    RAISE EXCEPTION 'Export audit rejected' USING ERRCODE = '42501';
  END IF;
  keys := ARRAY(SELECT DISTINCT f.k COLLATE "C" FROM unnest(filter_keys) AS f(k) ORDER BY 1);
  INSERT INTO app.activity(team_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
  VALUES (ctx.team_id, ctx.actor_id, ctx.auth_type, ctx.token_id::uuid, 'records.exported', 'export',
    'Exported ' || row_count || ' ' || resource,
    jsonb_build_object('resource', resource, 'rows', row_count, 'filters', to_jsonb(keys)));
END $$;
REVOKE ALL ON FUNCTION tenant_context.audit_export(text, integer, text[]) FROM PUBLIC;

-- Export rows come only from the helper above; no runtime role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (kind NOT IN ('api-token', 'mcp-tool', 'export') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
  OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied') AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'api-token' AND action = 'token.revoked' AND actor_type = 'token'
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
  OR (kind = 'export' AND action = 'records.exported' AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));
