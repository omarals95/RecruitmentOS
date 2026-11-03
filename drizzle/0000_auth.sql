CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth."user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, email_verified boolean NOT NULL DEFAULT false, image text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX auth_user_email_unique ON auth."user" (email);
CREATE UNIQUE INDEX auth_user_email_lower_unique ON auth."user" (lower(email));
CREATE TABLE auth.organization (id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE, logo text, metadata text, created_by text REFERENCES auth."user"(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX auth_organization_creator_idx ON auth.organization(created_by);
CREATE TABLE auth.session (id text PRIMARY KEY, expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ip_address text, user_agent text, user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE, active_organization_id text);
CREATE INDEX auth_session_user_idx ON auth.session(user_id);
CREATE TABLE auth.account (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_id, account_id));
CREATE INDEX auth_account_user_idx ON auth.account(user_id);
CREATE TABLE auth.verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX auth_verification_identifier_idx ON auth.verification(identifier);
CREATE TABLE auth.member (id text PRIMARY KEY, organization_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'viewer' CHECK(role IN ('owner','admin','recruiter','viewer')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,user_id));
CREATE INDEX auth_member_user_idx ON auth.member(user_id);
CREATE TABLE auth.invitation (id text PRIMARY KEY, organization_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE, email text NOT NULL, role text CHECK(role IS NULL OR role IN ('owner','admin','recruiter','viewer')), status text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL, inviter_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX auth_invitation_email_idx ON auth.invitation(email);
CREATE INDEX auth_invitation_organization_idx ON auth.invitation(organization_id);
CREATE TABLE auth.rate_limit (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL);
CREATE TABLE auth.api_tokens (id text PRIMARY KEY, team_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE, name text NOT NULL, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), prefix text NOT NULL, scopes jsonb NOT NULL CHECK(jsonb_typeof(scopes)='array'), expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX auth_api_tokens_team_user_idx ON auth.api_tokens(team_id,user_id);
CREATE TABLE auth.api_rate_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL CHECK(count>=0));

ALTER TABLE auth."user" ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.organization ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.session ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.account ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.verification ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.member ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.invitation ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.rate_limit ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE auth.api_tokens ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- Serialize owner changes on the organization row, including simultaneous demotions.
CREATE FUNCTION auth.protect_last_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role <> 'owner' OR (TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.organization_id = OLD.organization_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM id FROM auth.organization WHERE id=OLD.organization_id FOR UPDATE;
  IF FOUND AND NOT EXISTS (SELECT 1 FROM auth.member WHERE organization_id=OLD.organization_id AND role='owner' AND id<>OLD.id) THEN
    RAISE EXCEPTION 'A team must retain at least one owner' USING ERRCODE='23514', CONSTRAINT='auth_last_owner';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER auth_last_owner_guard BEFORE DELETE OR UPDATE OF role,organization_id ON auth.member FOR EACH ROW EXECUTE FUNCTION auth.protect_last_owner();

CREATE FUNCTION auth.limit_created_teams() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    PERFORM id FROM auth."user" WHERE id=NEW.created_by FOR UPDATE;
    IF (SELECT count(*) FROM auth.organization WHERE created_by=NEW.created_by) >= 5 THEN
      RAISE EXCEPTION 'A user may create at most five teams' USING ERRCODE='23514', CONSTRAINT='auth_team_creation_limit';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_team_creation_limit BEFORE INSERT ON auth.organization FOR EACH ROW EXECUTE FUNCTION auth.limit_created_teams();
