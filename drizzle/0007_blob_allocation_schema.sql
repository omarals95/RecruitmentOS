-- Typed CV storage references and a store-wide allocation ledger. Charges come from the upload
-- row, never from caller arguments, and only owner-run triggers and helpers change counters.

-- Each reference names its provider, environment and store; S3 and Blob identities stay separate.
ALTER TABLE app.uploads RENAME COLUMN object_version TO s3_version_id;
ALTER TABLE app.uploads DROP CONSTRAINT uploads_check;
ALTER TABLE app.uploads
  ADD COLUMN storage_provider text NOT NULL DEFAULT 's3',
  ADD COLUMN storage_environment text,
  ADD COLUMN storage_store text,
  ADD COLUMN blob_sha256 text,
  ADD COLUMN blob_size_bytes bigint;
-- Existing rows are legacy unbound S3 references; new rows must name their provider.
ALTER TABLE app.uploads ALTER COLUMN storage_provider DROP DEFAULT;
ALTER TABLE app.uploads
  ADD CONSTRAINT uploads_storage_provider_check CHECK (storage_provider IN ('s3','blob')),
  ADD CONSTRAINT uploads_storage_environment_check CHECK (storage_environment IN ('development','preview','production')),
  ADD CONSTRAINT uploads_storage_binding_check CHECK ((storage_environment IS NULL) = (storage_store IS NULL)
    AND (storage_store IS NOT NULL OR storage_provider = 's3')),
  ADD CONSTRAINT uploads_blob_store_check CHECK (storage_provider <> 'blob' OR storage_store ~ '^store_[A-Za-z0-9]{1,128}$'),
  ADD CONSTRAINT uploads_blob_sha256_check CHECK (blob_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT uploads_blob_size_bytes_check CHECK (blob_size_bytes >= 1 AND blob_size_bytes <= 10485760),
  ADD CONSTRAINT uploads_provider_reference_check CHECK (CASE storage_provider
    WHEN 's3' THEN blob_sha256 IS NULL AND blob_size_bytes IS NULL ELSE s3_version_id IS NULL END),
  ADD CONSTRAINT uploads_ready_check CHECK (status <> 'ready' OR (completed_at IS NOT NULL AND CASE storage_provider
    WHEN 's3' THEN s3_version_id IS NOT NULL
    ELSE blob_sha256 IS NOT NULL AND blob_size_bytes IS NOT NULL AND blob_size_bytes = size_bytes END));
-- A pathname is never reused, whatever the team or status.
CREATE UNIQUE INDEX uploads_provider_object_key_unique ON app.uploads(storage_provider, object_key);

-- Team limits are nullable: null inherits the budget of the store being charged.
ALTER TABLE app.storage_usage
  DROP CONSTRAINT storage_usage_check,
  DROP CONSTRAINT storage_usage_check1,
  ADD COLUMN retained_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_bytes >= 0),
  ADD COLUMN retained_files integer NOT NULL DEFAULT 0 CHECK (retained_files >= 0),
  ALTER COLUMN max_bytes DROP NOT NULL,
  ALTER COLUMN max_bytes DROP DEFAULT,
  ALTER COLUMN max_files DROP NOT NULL,
  ALTER COLUMN max_files DROP DEFAULT;
-- The owner is subject to FORCE RLS; lift it only for this backfill inside the migration transaction.
ALTER TABLE app.storage_usage NO FORCE ROW LEVEL SECURITY;
UPDATE app.storage_usage SET max_bytes = NULL WHERE max_bytes = 10737418240;
UPDATE app.storage_usage SET max_files = NULL WHERE max_files = 10000;
ALTER TABLE app.storage_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE app.storage_usage
  ADD CONSTRAINT storage_usage_bytes_limit_check CHECK (max_bytes IS NULL OR used_bytes + reserved_bytes + retained_bytes <= max_bytes),
  ADD CONSTRAINT storage_usage_files_limit_check CHECK (max_files IS NULL OR used_files + reserved_files + retained_files <= max_files);

-- Owner-only approved budgets and the store-level ledger that spans every team.
CREATE SCHEMA storage_ledger;
REVOKE ALL ON SCHEMA storage_ledger FROM PUBLIC;
CREATE TABLE storage_ledger.budgets (
  environment text PRIMARY KEY CHECK (environment IN ('development','preview','production')),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  max_files integer NOT NULL CHECK (max_files > 0)
);
INSERT INTO storage_ledger.budgets(environment, max_bytes, max_files) VALUES
  ('production', 600000000, 2000),
  ('preview', 200000000, 500),
  ('development', 200000000, 500);
CREATE TABLE storage_ledger.stores (
  provider text NOT NULL CHECK (provider IN ('s3','blob')),
  store text NOT NULL CHECK (store ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'),
  environment text NOT NULL REFERENCES storage_ledger.budgets(environment),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  retained_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_bytes >= 0),
  used_files integer NOT NULL DEFAULT 0 CHECK (used_files >= 0),
  reserved_files integer NOT NULL DEFAULT 0 CHECK (reserved_files >= 0),
  retained_files integer NOT NULL DEFAULT 0 CHECK (retained_files >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, store),
  CHECK (provider <> 'blob' OR store ~ '^store_[A-Za-z0-9]{1,128}$')
);
REVOKE ALL ON ALL TABLES IN SCHEMA storage_ledger FROM PUBLIC;

-- Owner-controlled singleton that startup compares with the code's storage schema version.
CREATE TABLE db_boundary.storage_schema (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version > 0)
);
INSERT INTO db_boundary.storage_schema(version) VALUES (1);
REVOKE ALL ON db_boundary.storage_schema FROM PUBLIC;

-- Runs as the caller, so current_user is the real writer; the definer helpers pass as the owner.
CREATE FUNCTION storage_ledger.refuse_unless_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context') THEN
    RAISE EXCEPTION 'Storage ledger change rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

-- Status moves only from pending; other callers also cannot rewrite a reference or its result.
CREATE FUNCTION storage_ledger.guard_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('ready','rejected')) THEN
    RAISE EXCEPTION 'Upload status transition rejected' USING ERRCODE = '23514';
  END IF;
  IF current_user IS DISTINCT FROM (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')
     AND ((NEW.id, NEW.team_id, NEW.candidate_id, NEW.original_name, NEW.mime_type, NEW.size_bytes, NEW.object_key,
           NEW.storage_provider, NEW.storage_environment, NEW.storage_store, NEW.created_by, NEW.created_at,
           NEW.expires_at, NEW.legacy_source_id, NEW.source_path)
          IS DISTINCT FROM (OLD.id, OLD.team_id, OLD.candidate_id, OLD.original_name, OLD.mime_type, OLD.size_bytes, OLD.object_key,
           OLD.storage_provider, OLD.storage_environment, OLD.storage_store, OLD.created_by, OLD.created_at,
           OLD.expires_at, OLD.legacy_source_id, OLD.source_path)
       OR (NOT (OLD.status = 'pending' AND NEW.status = 'ready')
           AND (NEW.s3_version_id, NEW.blob_sha256, NEW.blob_size_bytes, NEW.completed_at)
             IS DISTINCT FROM (OLD.s3_version_id, OLD.blob_sha256, OLD.blob_size_bytes, OLD.completed_at))) THEN
    RAISE EXCEPTION 'Upload reference is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Locks store, then team, then refuses a reservation either budget cannot hold. The BEFORE pass
-- validates and refuses; the AFTER pass charges, so a row skipped by ON CONFLICT is never charged.
CREATE FUNCTION storage_ledger.charge_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  store_row storage_ledger.stores%ROWTYPE;
  budget_row storage_ledger.budgets%ROWTYPE;
  team_row app.storage_usage%ROWTYPE;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.storage_environment IS NULL OR NEW.storage_store IS NULL
     OR NEW.s3_version_id IS NOT NULL OR NEW.blob_sha256 IS NOT NULL OR NEW.blob_size_bytes IS NOT NULL
     OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO store_row FROM storage_ledger.stores s
    WHERE s.provider = NEW.storage_provider AND s.store = NEW.storage_store FOR UPDATE;
  IF NOT FOUND OR store_row.environment IS DISTINCT FROM NEW.storage_environment THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO budget_row FROM storage_ledger.budgets b WHERE b.environment = store_row.environment;
  SELECT * INTO team_row FROM app.storage_usage u WHERE u.team_id = NEW.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  IF store_row.used_bytes + store_row.reserved_bytes + store_row.retained_bytes + NEW.size_bytes > budget_row.max_bytes
     OR store_row.used_files + store_row.reserved_files + store_row.retained_files + 1 > budget_row.max_files
     OR team_row.used_bytes + team_row.reserved_bytes + team_row.retained_bytes + NEW.size_bytes
       > coalesce(team_row.max_bytes, budget_row.max_bytes)
     OR team_row.used_files + team_row.reserved_files + team_row.retained_files + 1
       > coalesce(team_row.max_files, budget_row.max_files) THEN
    RAISE EXCEPTION 'Storage quota exceeded' USING ERRCODE = 'RQ001';
  END IF;
  IF TG_WHEN = 'BEFORE' THEN
    RETURN NEW;
  END IF;
  UPDATE storage_ledger.stores s SET reserved_bytes = s.reserved_bytes + NEW.size_bytes,
    reserved_files = s.reserved_files + 1, updated_at = clock_timestamp()
    WHERE s.provider = NEW.storage_provider AND s.store = NEW.storage_store;
  UPDATE app.storage_usage u SET reserved_bytes = u.reserved_bytes + NEW.size_bytes,
    reserved_files = u.reserved_files + 1, updated_at = clock_timestamp()
    WHERE u.team_id = NEW.team_id;
  RETURN NULL;
END $$;

-- Settles the insert-time charge once: ready moves it to used, a rejected Blob ticket keeps it
-- as retained, and a rejected S3 ticket releases it. Legacy unbound rows were charged to the team only.
CREATE FUNCTION storage_ledger.settle_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  to_used boolean := NEW.status = 'ready';
  to_retained boolean := NEW.status = 'rejected' AND OLD.storage_provider = 'blob';
BEGIN
  IF OLD.storage_store IS NOT NULL THEN
    UPDATE storage_ledger.stores s SET reserved_bytes = s.reserved_bytes - OLD.size_bytes,
      reserved_files = s.reserved_files - 1,
      used_bytes = s.used_bytes + CASE WHEN to_used THEN OLD.size_bytes ELSE 0 END,
      used_files = s.used_files + CASE WHEN to_used THEN 1 ELSE 0 END,
      retained_bytes = s.retained_bytes + CASE WHEN to_retained THEN OLD.size_bytes ELSE 0 END,
      retained_files = s.retained_files + CASE WHEN to_retained THEN 1 ELSE 0 END,
      updated_at = clock_timestamp()
      WHERE s.provider = OLD.storage_provider AND s.store = OLD.storage_store;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE app.storage_usage u SET reserved_bytes = u.reserved_bytes - OLD.size_bytes,
    reserved_files = u.reserved_files - 1,
    used_bytes = u.used_bytes + CASE WHEN to_used THEN OLD.size_bytes ELSE 0 END,
    used_files = u.used_files + CASE WHEN to_used THEN 1 ELSE 0 END,
    retained_bytes = u.retained_bytes + CASE WHEN to_retained THEN OLD.size_bytes ELSE 0 END,
    retained_files = u.retained_files + CASE WHEN to_retained THEN 1 ELSE 0 END,
    updated_at = clock_timestamp()
    WHERE u.team_id = OLD.team_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage settlement rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

-- Takes the store lock, then the context team's lock, before any upload row is touched. The
-- first lock of a store fixes its environment; a later mismatch is refused.
CREATE FUNCTION tenant_context.lock_storage_allocation(binding_provider text, binding_environment text, binding_store text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  fixed_environment text;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND 'cvs:write' = ANY(c.scopes);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
  IF binding_provider IS NULL OR binding_provider NOT IN ('s3','blob') OR binding_store IS NULL
     OR binding_store !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'
     OR (binding_provider = 'blob' AND binding_store !~ '^store_[A-Za-z0-9]{1,128}$')
     OR NOT EXISTS (SELECT 1 FROM storage_ledger.budgets b WHERE b.environment = binding_environment) THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  INSERT INTO storage_ledger.stores(provider, store, environment)
    VALUES (binding_provider, binding_store, binding_environment) ON CONFLICT (provider, store) DO NOTHING;
  SELECT s.environment INTO fixed_environment FROM storage_ledger.stores s
    WHERE s.provider = binding_provider AND s.store = binding_store FOR UPDATE;
  IF fixed_environment IS DISTINCT FROM binding_environment THEN
    RAISE EXCEPTION 'Storage binding rejected' USING ERRCODE = 'RQ002';
  END IF;
  INSERT INTO app.storage_usage(team_id) VALUES (ctx.team_id) ON CONFLICT (team_id) DO NOTHING;
  PERFORM 1 FROM app.storage_usage u WHERE u.team_id = ctx.team_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Storage allocation rejected' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE TRIGGER uploads_guard BEFORE UPDATE ON app.uploads
  FOR EACH ROW EXECUTE FUNCTION storage_ledger.guard_upload();
CREATE TRIGGER uploads_charge BEFORE INSERT ON app.uploads
  FOR EACH ROW EXECUTE FUNCTION storage_ledger.charge_upload();
CREATE TRIGGER uploads_charge_applied AFTER INSERT ON app.uploads
  FOR EACH ROW EXECUTE FUNCTION storage_ledger.charge_upload();
CREATE TRIGGER uploads_settle AFTER UPDATE ON app.uploads
  FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status <> 'pending') EXECUTE FUNCTION storage_ledger.settle_upload();
CREATE TRIGGER uploads_owner_only BEFORE DELETE OR TRUNCATE ON app.uploads
  FOR EACH STATEMENT EXECUTE FUNCTION storage_ledger.refuse_unless_owner();
CREATE TRIGGER storage_usage_owner_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON app.storage_usage
  FOR EACH STATEMENT EXECUTE FUNCTION storage_ledger.refuse_unless_owner();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA storage_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_context.lock_storage_allocation(text, text, text) FROM PUBLIC;
