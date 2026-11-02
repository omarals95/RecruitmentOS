DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['records','candidate_states','activity','uploads','storage_usage','idempotency','notification_reads'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY team_isolation ON app.%I USING (team_id = nullif(current_setting(''app.team_id'',true),'''')) WITH CHECK (team_id = nullif(current_setting(''app.team_id'',true),''''))',tbl);
 END LOOP;
END $$;
CREATE POLICY personal_state ON app.candidate_states AS RESTRICTIVE USING(user_id=nullif(current_setting('app.user_id',true),'')) WITH CHECK(user_id=nullif(current_setting('app.user_id',true),''));
CREATE POLICY personal_notifications ON app.notification_reads AS RESTRICTIVE USING(user_id=nullif(current_setting('app.user_id',true),'')) WITH CHECK(user_id=nullif(current_setting('app.user_id',true),''));
CREATE POLICY private_views ON app.records AS RESTRICTIVE USING(private_owner_id IS NULL OR private_owner_id=nullif(current_setting('app.user_id',true),'')) WITH CHECK(private_owner_id IS NULL OR private_owner_id=nullif(current_setting('app.user_id',true),''));
CREATE FUNCTION app.prevent_activity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Activity history is append-only'; END $$;
CREATE TRIGGER immutable_activity BEFORE UPDATE OR DELETE ON app.activity FOR EACH ROW EXECUTE FUNCTION app.prevent_activity_mutation();
