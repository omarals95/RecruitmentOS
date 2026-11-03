CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE app.records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id text NOT NULL REFERENCES auth.organization(id), kind text NOT NULL CHECK(kind IN ('candidate','job-role','vacancy','application','bucket','task-field','task','interview','offer','onboarding','checklist','saved-view','comment')),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), version integer NOT NULL DEFAULT 1 CHECK(version>0), legacy_id text,
 candidate_id uuid, vacancy_id uuid, application_id uuid, onboarding_id uuid, bucket_id uuid, job_role_id uuid, parent_record_id uuid,
 private_owner_id text REFERENCES auth."user"(id), import_meta jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(import_meta)='object'), created_by text NOT NULL REFERENCES auth."user"(id), created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz,
 UNIQUE(team_id,id),
 FOREIGN KEY(team_id,candidate_id) REFERENCES app.records(team_id,id), FOREIGN KEY(team_id,vacancy_id) REFERENCES app.records(team_id,id), FOREIGN KEY(team_id,application_id) REFERENCES app.records(team_id,id), FOREIGN KEY(team_id,onboarding_id) REFERENCES app.records(team_id,id), FOREIGN KEY(team_id,bucket_id) REFERENCES app.records(team_id,id), FOREIGN KEY(team_id,job_role_id) REFERENCES app.records(team_id,id), FOREIGN KEY(team_id,parent_record_id) REFERENCES app.records(team_id,id),
 CHECK((kind='saved-view')=(private_owner_id IS NOT NULL)),
 CHECK(kind<>'application' OR(candidate_id IS NOT NULL AND vacancy_id IS NOT NULL)), CHECK(kind<>'task' OR bucket_id IS NOT NULL), CHECK(kind NOT IN('interview','offer','onboarding') OR application_id IS NOT NULL), CHECK(kind<>'checklist' OR onboarding_id IS NOT NULL), CHECK(kind<>'comment' OR parent_record_id IS NOT NULL)
);
CREATE INDEX records_team_kind_idx ON app.records(team_id,kind);
CREATE INDEX records_team_updated_idx ON app.records(team_id,updated_at DESC);
CREATE INDEX records_data_gin_idx ON app.records USING gin(data jsonb_path_ops);
CREATE UNIQUE INDEX records_legacy_unique ON app.records(team_id,kind,legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX applications_active_pair ON app.records(team_id,candidate_id,vacancy_id) WHERE kind='application' AND archived_at IS NULL;
CREATE UNIQUE INDEX onboarding_active_pair ON app.records(team_id,application_id) WHERE kind='onboarding' AND archived_at IS NULL;
CREATE UNIQUE INDEX vacancy_requisition_unique ON app.records(team_id,lower(data->>'requisitionId')) WHERE kind='vacancy' AND coalesce(data->>'requisitionId','')<>'';
CREATE UNIQUE INDEX config_name_unique ON app.records(team_id,kind,lower(data->>'name')) WHERE kind IN ('bucket','task-field') AND archived_at IS NULL;
CREATE TABLE app.candidate_states (
 team_id text NOT NULL REFERENCES auth.organization(id),user_id text NOT NULL REFERENCES auth."user"(id),candidate_id uuid NOT NULL,shortlisted boolean NOT NULL DEFAULT false,status text NOT NULL DEFAULT 'New' CHECK(status IN('New','To contact','Contacted','Interviewing','On hold','Closed')),note text NOT NULL DEFAULT '' CHECK(length(note)<=10000),version integer NOT NULL DEFAULT 1 CHECK(version>0),import_meta jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(import_meta)='object'),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(team_id,user_id,candidate_id),FOREIGN KEY(team_id,candidate_id) REFERENCES app.records(team_id,id)
);
CREATE TABLE app.activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),team_id text NOT NULL REFERENCES auth.organization(id),record_id uuid,actor_id text NOT NULL REFERENCES auth."user"(id),actor_type text NOT NULL CHECK(actor_type IN('session','token','import')),token_id uuid,action text NOT NULL,kind text NOT NULL,summary text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(team_id,record_id) REFERENCES app.records(team_id,id)
);
CREATE INDEX activity_team_created_idx ON app.activity(team_id,created_at DESC);
CREATE TABLE app.uploads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),team_id text NOT NULL REFERENCES auth.organization(id),candidate_id uuid NOT NULL,original_name text NOT NULL,mime_type text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=10485760),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','ready','rejected')),object_key text NOT NULL,object_version text,legacy_source_id text,source_path text,created_by text NOT NULL REFERENCES auth."user"(id),created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,expires_at timestamptz NOT NULL,FOREIGN KEY(team_id,candidate_id) REFERENCES app.records(team_id,id),CHECK(status<>'ready' OR(object_version IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX uploads_legacy_unique ON app.uploads(team_id,legacy_source_id) WHERE legacy_source_id IS NOT NULL;
CREATE INDEX uploads_team_candidate_idx ON app.uploads(team_id,candidate_id);
CREATE TABLE app.storage_usage (
 team_id text PRIMARY KEY REFERENCES auth.organization(id),used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),used_files integer NOT NULL DEFAULT 0 CHECK(used_files>=0),reserved_files integer NOT NULL DEFAULT 0 CHECK(reserved_files>=0),max_bytes bigint NOT NULL DEFAULT 10737418240 CHECK(max_bytes>0),max_files integer NOT NULL DEFAULT 10000 CHECK(max_files>0),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(used_bytes+reserved_bytes<=max_bytes),CHECK(used_files+reserved_files<=max_files)
);
CREATE TABLE app.idempotency (
 team_id text NOT NULL REFERENCES auth.organization(id),actor_key text NOT NULL,operation text NOT NULL,key text NOT NULL CHECK(length(key)<=200),payload_hash text NOT NULL,response jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(team_id,actor_key,operation,key)
);
CREATE TABLE app.notification_reads (
 team_id text NOT NULL REFERENCES auth.organization(id),user_id text NOT NULL REFERENCES auth."user"(id),key text NOT NULL CHECK(length(key)<=300),read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(team_id,user_id,key)
);
