-- Bulk CV intake recovery rows. Each batch and item is private to the user who created it in its team.
-- The rows hold file metadata, a hash of the reviewed candidate data and the review evidence only:
-- never a candidate name, email, phone or any other field value. The application sets expires_at once,
-- from its recovery window, and never extends it; expired rows are refused and deleted when their user
-- next imports.

-- Item rows reference an upload within the same team.
ALTER TABLE app.uploads ADD CONSTRAINT uploads_team_id_id_key UNIQUE (team_id, id);

CREATE TABLE app.bulk_intake_batches (
  id uuid PRIMARY KEY,
  team_id text NOT NULL REFERENCES auth.organization(id),
  created_by text NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  UNIQUE (team_id, id, created_by)
);
CREATE INDEX bulk_intake_batches_owner_idx ON app.bulk_intake_batches(team_id, created_by, expires_at);

CREATE TABLE app.bulk_intake_items (
  id uuid PRIMARY KEY,
  team_id text NOT NULL REFERENCES auth.organization(id),
  batch_id uuid NOT NULL,
  created_by text NOT NULL REFERENCES auth."user"(id),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 180),
  mime_type text NOT NULL CHECK (length(mime_type) <= 150),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz,
  possible_duplicates integer CHECK (possible_duplicates >= 0),
  candidate_id uuid,
  upload_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- The item's creator is the batch's creator; deleting a batch deletes its items.
  FOREIGN KEY (team_id, batch_id, created_by) REFERENCES app.bulk_intake_batches(team_id, id, created_by) ON DELETE CASCADE,
  FOREIGN KEY (team_id, candidate_id) REFERENCES app.records(team_id, id),
  FOREIGN KEY (team_id, upload_id) REFERENCES app.uploads(team_id, id),
  -- Review evidence is written with the candidate, and an upload needs that candidate.
  CHECK ((candidate_id IS NULL) = (reviewed_at IS NULL) AND (candidate_id IS NULL) = (possible_duplicates IS NULL)),
  CHECK (upload_id IS NULL OR candidate_id IS NOT NULL)
);
CREATE INDEX bulk_intake_items_batch_idx ON app.bulk_intake_items(team_id, batch_id, created_by);

ALTER TABLE app.bulk_intake_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_intake_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bulk_intake_items FORCE ROW LEVEL SECURITY;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['bulk_intake_batches','bulk_intake_items'] LOOP
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (tenant_context.allows(team_id, created_by, ''read''))', tbl);
  EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (tenant_context.allows(team_id, created_by, ''write''))', tbl);
  EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (tenant_context.allows(team_id, created_by, ''write'')) WITH CHECK (tenant_context.allows(team_id, created_by, ''write''))', tbl);
  EXECUTE format('CREATE POLICY context_delete ON app.%I FOR DELETE USING (tenant_context.allows(team_id, created_by, ''write''))', tbl);
 END LOOP;
END $$;
