LOCK TABLE auth."user", auth.organization, auth.member IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE auth.initial_admin_claim (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  user_id text,
  completed_at timestamptz
);
INSERT INTO auth.initial_admin_claim(id,completed_at)
SELECT true,now() WHERE EXISTS(SELECT 1 FROM auth."user") OR EXISTS(SELECT 1 FROM auth.organization)
ON CONFLICT DO NOTHING;
ALTER TABLE auth."user" ADD COLUMN initial_admin boolean NOT NULL DEFAULT false;
CREATE FUNCTION auth.claim_initial_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('recruitmentos:initial-admin', 0));
  IF NEW.initial_admin THEN
    IF EXISTS(SELECT 1 FROM auth."user") OR EXISTS(SELECT 1 FROM auth.organization) THEN
      RAISE EXCEPTION 'Initial administrator setup is closed' USING ERRCODE='23514';
    END IF;
    INSERT INTO auth.initial_admin_claim(id,user_id) VALUES(true,NEW.id);
  ELSIF NOT EXISTS(SELECT 1 FROM auth.initial_admin_claim WHERE completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Initial administrator setup is required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_initial_admin_guard BEFORE INSERT ON auth."user"
FOR EACH ROW EXECUTE FUNCTION auth.claim_initial_admin();
CREATE FUNCTION auth.complete_initial_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role='owner' AND EXISTS(SELECT 1 FROM auth.organization WHERE id=NEW.organization_id AND created_by=NEW.user_id) AND EXISTS(SELECT 1 FROM auth."user" WHERE id=NEW.user_id AND initial_admin AND email_verified) THEN
    UPDATE auth.initial_admin_claim SET completed_at=coalesce(completed_at,now()) WHERE id=true AND user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_initial_admin_completed AFTER INSERT OR UPDATE OF role,user_id,organization_id ON auth.member
FOR EACH ROW EXECUTE FUNCTION auth.complete_initial_admin();
