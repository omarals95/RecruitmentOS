-- Better Auth two-factor plugin storage: the user's flag and one TOTP secret plus backup codes per
-- user, both encrypted by the plugin. Identity tables only, so identity test databases can apply it.
ALTER TABLE auth."user" ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE auth.two_factor (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL UNIQUE REFERENCES auth."user"(id) ON DELETE CASCADE,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
  locked_until timestamptz
);
REVOKE ALL ON auth.two_factor FROM PUBLIC;
