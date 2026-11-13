-- Scoped-member speed (R2-PERF-01, job 063). Apply after 0038_record_scope_rls.sql; the role template
-- is unchanged and needs no rerun. tenant_context.candidate_in_scope (0038) finds the candidate it
-- tests by team, kind and id. Without planner statistics PostgreSQL reads that row through
-- records_team_kind_idx, walking the team's candidates up to it on each call, so the record_scope
-- policy cost grew with the team's candidates for every candidate row a scoped member's statement
-- read. This partial index matches the lookup exactly. No policy, helper, grant or business row
-- changes, and the storage schema marker stays at 17: the code is correct without the index, only
-- slower.
CREATE INDEX records_candidate_id_idx ON app.records(team_id, id) WHERE kind = 'candidate';
