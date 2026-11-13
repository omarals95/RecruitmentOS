-- Positions, employees and their position history (R2a-14, job 049). Apply after
-- 0033_org_levels_units.sql, then rerun infrastructure/postgres-split-runtime-roles.sql, which grants
-- the data role SELECT, INSERT and UPDATE on the three tables and EXECUTE on
-- tenant_context.allows_directory and tenant_context.home_unit_changes. The facts that set a member's
-- home units (an employee's user link, a linked employee's positions and the unit of a position a
-- linked employee holds) need a company owner session, as unit moves do, and a position names a
-- current job role of the writer's own team only. app.guard_scope_sources(),
-- app.maintain_org_closure() and app.guard_org_archive() are replaced to also refuse a runtime
-- transaction that is not read committed. The storage schema marker goes to 13, so startup refuses a
-- database without this migration. tenant_context.install, the team tables and their policies are
-- unchanged.

-- Company rows keyed by workspace (D1). A position sits in one unit and may name one job role of a
-- team; its code is unique among the workspace's current rows. Employees hold work contact facts
-- only: no date of birth, nationality, gender, photo or home address (architecture 11.1).
CREATE TABLE app.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  org_unit_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 120),
  job_role_team_id text,
  job_role_id uuid,
  is_manager boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  archived_at timestamptz,
  CONSTRAINT positions_valid_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT positions_job_role_check CHECK ((job_role_team_id IS NULL) = (job_role_id IS NULL)),
  UNIQUE (id, workspace_id),
  CONSTRAINT positions_unit_fkey FOREIGN KEY (org_unit_id, workspace_id) REFERENCES app.org_units(id, workspace_id),
  CONSTRAINT positions_job_role_fkey FOREIGN KEY (job_role_team_id, job_role_id) REFERENCES app.records(team_id, id)
);
CREATE UNIQUE INDEX positions_current_code ON app.positions(workspace_id, code)
  WHERE valid_to IS NULL AND archived_at IS NULL;
CREATE INDEX positions_unit_idx ON app.positions(workspace_id, org_unit_id);
CREATE TABLE app.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  work_email text CHECK (char_length(work_email) <= 320),
  work_phone text CHECK (char_length(work_phone) <= 100),
  employee_number text NOT NULL CHECK (char_length(employee_number) BETWEEN 1 AND 120),
  user_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'excel')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT employees_number_unique UNIQUE (workspace_id, employee_number),
  CONSTRAINT employees_user_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id),
  UNIQUE (id, workspace_id)
);
-- A user is linked to at most one employee per workspace.
CREATE UNIQUE INDEX employees_user_link ON app.employees(workspace_id, user_id) WHERE user_id IS NOT NULL;
-- One employee holds a position once at a time, with at most one current primary position.
CREATE TABLE app.employee_positions (
  employee_id uuid NOT NULL,
  position_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  "primary" boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  CONSTRAINT employee_positions_valid_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_positions_employee_fkey FOREIGN KEY (employee_id, workspace_id) REFERENCES app.employees(id, workspace_id),
  CONSTRAINT employee_positions_position_fkey FOREIGN KEY (position_id, workspace_id) REFERENCES app.positions(id, workspace_id)
);
CREATE UNIQUE INDEX employee_positions_current ON app.employee_positions(employee_id, position_id) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX employee_positions_primary ON app.employee_positions(employee_id) WHERE "primary" AND valid_to IS NULL;
CREATE INDEX employee_positions_position_idx ON app.employee_positions(workspace_id, position_id);

-- Positions are company structure, like units: any context of the row's workspace reads, and a
-- session with the organisation area or a company owner writes (allows_workspace, 0030). Employees
-- and their positions need directory:read to read and a session with directory:write to write
-- (allows_directory below). An update may target any readable row, so a reader's update reaches the
-- guards below and fails with 42501 instead of matching no row. No runtime role deletes.
CREATE FUNCTION tenant_context.allows_directory(row_workspace uuid, access text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace
      AND CASE access WHEN 'read' THEN 'directory:read' = ANY(c.scopes)
        WHEN 'write' THEN 'directory:write' = ANY(c.scopes) AND c.auth_type = 'session'
        ELSE false END)
$$;
REVOKE ALL ON FUNCTION tenant_context.allows_directory(uuid, text) FROM PUBLIC;

DO $directory_rls$ DECLARE tbl text; command text; read_rule text; write_rule text; owner_only text :=
  'current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = ''tenant_context'')';
BEGIN
 FOREACH tbl IN ARRAY ARRAY['positions','employees','employee_positions'] LOOP
  IF tbl = 'positions' THEN
   read_rule := 'tenant_context.allows_workspace(workspace_id, ''read'', ''organisation'')';
   write_rule := 'tenant_context.allows_workspace(workspace_id, ''write'', ''organisation'')';
  ELSE
   read_rule := 'tenant_context.allows_directory(workspace_id, ''read'')';
   write_rule := 'tenant_context.allows_directory(workspace_id, ''write'')';
  END IF;
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', tbl);
  -- Owner-only access for the migration, the trigger functions and the owner's fixture cleanup.
  FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('CREATE POLICY %I ON app.%I FOR %s %s', 'directory_owner_' || lower(command), tbl, command,
     CASE command
       WHEN 'INSERT' THEN format('WITH CHECK (%s)', owner_only)
       WHEN 'UPDATE' THEN format('USING (%s) WITH CHECK (%s)', owner_only, owner_only)
       ELSE format('USING (%s)', owner_only) END);
  END LOOP;
  EXECUTE format('CREATE POLICY context_read ON app.%I FOR SELECT USING (%s)', tbl, read_rule);
  EXECUTE format('CREATE POLICY context_insert ON app.%I FOR INSERT WITH CHECK (%s)', tbl, write_rule);
  EXECUTE format('CREATE POLICY context_update ON app.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, read_rule, write_rule);
 END LOOP;
END $directory_rls$;

-- Row rules for a runtime role, the sibling of app.guard_org_row (0033) and like it a security
-- invoker function, so current_user is the caller. Archiving a position or an employee is one-way
-- for everyone, and every employee update sets updated_at. A runtime insert is never archived; a
-- position's or a position row's insert is never closed and takes the valid_from default only,
-- which the time the row is written replaces, so app.guard_scope_sources orders a code's rows as
-- they were written. After insert a position keeps its id, workspace, code and dates, an employee
-- its id, workspace, source and creation time, and a position row may change only primary and end
-- once, at the time it is written.
CREATE FUNCTION app.guard_directory_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner boolean := current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context');
BEGIN
  IF TG_TABLE_NAME = 'employee_positions' THEN
    IF owner THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.valid_to IS NOT NULL OR NEW.valid_from IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'Directory row rejected' USING ERRCODE = '42501';
      END IF;
      NEW.valid_from := clock_timestamp();
    ELSIF (NEW.employee_id, NEW.position_id, NEW.workspace_id, NEW.valid_from)
        IS DISTINCT FROM (OLD.employee_id, OLD.position_id, OLD.workspace_id, OLD.valid_from)
      OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to) THEN
      RAISE EXCEPTION 'Directory row rejected' USING ERRCODE = '42501';
    ELSIF NEW.valid_to IS NOT NULL AND OLD.valid_to IS NULL THEN
      NEW.valid_to := clock_timestamp();
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.archived_at IS DISTINCT FROM OLD.archived_at
     AND (OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL) THEN
    RAISE EXCEPTION 'An archived position or employee stays archived' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'employees' AND TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  IF owner THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Directory row rejected' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'positions' THEN
      IF NEW.valid_to IS NOT NULL OR NEW.valid_from IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'Directory row rejected' USING ERRCODE = '42501';
      END IF;
      NEW.valid_from := clock_timestamp();
    END IF;
  ELSIF TG_TABLE_NAME = 'positions' THEN
    IF (NEW.id, NEW.workspace_id, NEW.code, NEW.valid_from, NEW.valid_to)
        IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.code, OLD.valid_from, OLD.valid_to) THEN
      RAISE EXCEPTION 'Directory row rejected' USING ERRCODE = '42501';
    END IF;
  ELSIF (NEW.id, NEW.workspace_id, NEW.source, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.source, OLD.created_at) THEN
    RAISE EXCEPTION 'Directory row rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_directory_row() FROM PUBLIC;
CREATE TRIGGER positions_guard BEFORE INSERT OR UPDATE ON app.positions
  FOR EACH ROW EXECUTE FUNCTION app.guard_directory_row();
CREATE TRIGGER employees_guard BEFORE INSERT OR UPDATE ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.guard_directory_row();
CREATE TRIGGER employee_positions_guard BEFORE INSERT OR UPDATE ON app.employee_positions
  FOR EACH ROW EXECUTE FUNCTION app.guard_directory_row();

-- A position names a job role of the writer's own team only. The foreign key alone accepts any
-- record of any team, and its check ignores RLS. So for any caller with a context, an insert or a
-- change of the job role to a non-null value needs the context's team, a job-role record that is
-- not archived, and that team in the row's workspace (42501 otherwise). Other record kinds, which
-- erasure deletes, can then never be referenced, and no other team's id is planted in a row the
-- whole workspace reads. A security definer function, because only the owner reads the context
-- table and other teams' records; the owner's own SQL has no context row and is let through.
CREATE FUNCTION app.guard_position_job_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()) THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Organisation and directory changes need a read committed transaction' USING ERRCODE = '42501';
  END IF;
  IF NEW.job_role_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.job_role_team_id, NEW.job_role_id) IS NOT DISTINCT FROM (OLD.job_role_team_id, OLD.job_role_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND OR NEW.job_role_team_id IS DISTINCT FROM ctx.team_id
     OR NOT EXISTS (SELECT 1 FROM app.records r JOIN app.workspace_teams t ON t.team_id = r.team_id
       WHERE r.team_id = NEW.job_role_team_id AND r.id = NEW.job_role_id AND r.kind = 'job-role'
         AND r.archived_at IS NULL AND t.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'A position names a current job role of your own team only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_position_job_role() FROM PUBLIC;
CREATE TRIGGER positions_job_role BEFORE INSERT OR UPDATE ON app.positions
  FOR EACH ROW EXECUTE FUNCTION app.guard_position_job_role();

-- As in 0033, plus the home-unit facts of R2a-14 (architecture 6.5): an employee insert with a user
-- link or any change of the link; any insert, update or delete of a position row of a linked
-- employee; and, for a position a linked employee currently holds, a unit change, an archive, or an
-- insert giving its code (latest row by valid_from) another unit. Each needs a session context whose
-- company level is owner in the row's workspace. Every trigger function that reads ancestry or a
-- latest row also refuses a runtime transaction that is not read committed: the workspace lock and
-- the latest-row lookups rely on each statement taking a fresh snapshot. The owner's own SQL has no
-- context row and is let through.
CREATE OR REPLACE FUNCTION app.guard_scope_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
  employee uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned())
     AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Organisation and directory changes need a read committed transaction' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_workspace := OLD.workspace_id;
  ELSE
    row_workspace := NEW.workspace_id;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp();
  IF NOT FOUND OR (ctx.auth_type = 'session' AND ctx.company_level = 'owner' AND ctx.workspace_id = row_workspace) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'org_units' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        RAISE EXCEPTION 'Only a company owner can move or archive an organisation unit' USING ERRCODE = '42501';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM (SELECT u.parent_id FROM app.org_units u
          WHERE u.workspace_id = NEW.workspace_id AND u.code = NEW.code
          ORDER BY u.valid_from DESC, u.id DESC LIMIT 1) latest
        WHERE latest.parent_id IS DISTINCT FROM NEW.parent_id) THEN
      RAISE EXCEPTION 'Only a company owner can give an organisation unit a new parent' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'employees' THEN
    IF (TG_OP = 'INSERT' AND NEW.user_id IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
      RAISE EXCEPTION 'Only a company owner can link an employee to a user' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'employee_positions' THEN
    IF TG_OP = 'DELETE' THEN
      employee := OLD.employee_id;
    ELSE
      employee := NEW.employee_id;
    END IF;
    IF EXISTS (SELECT 1 FROM app.employees e
        WHERE e.workspace_id = row_workspace AND e.id = employee AND e.user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Only a company owner can change the positions of an employee linked to a user' USING ERRCODE = '42501';
    END IF;
  -- Positions.
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at)
       AND EXISTS (SELECT 1 FROM app.employee_positions ep
         JOIN app.employees e ON e.id = ep.employee_id AND e.workspace_id = ep.workspace_id
         WHERE ep.workspace_id = row_workspace AND ep.position_id = OLD.id AND ep.valid_to IS NULL AND e.user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Only a company owner can move or archive a position held by an employee linked to a user' USING ERRCODE = '42501';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM (SELECT p.id, p.org_unit_id FROM app.positions p
        WHERE p.workspace_id = NEW.workspace_id AND p.code = NEW.code
        ORDER BY p.valid_from DESC, p.id DESC LIMIT 1) latest
      WHERE latest.org_unit_id IS DISTINCT FROM NEW.org_unit_id
        AND EXISTS (SELECT 1 FROM app.employee_positions ep
          JOIN app.employees e ON e.id = ep.employee_id AND e.workspace_id = ep.workspace_id
          WHERE ep.workspace_id = row_workspace AND ep.position_id = latest.id AND ep.valid_to IS NULL AND e.user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Only a company owner can give a held position a new unit' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_scope_sources() FROM PUBLIC;
CREATE TRIGGER positions_scope BEFORE INSERT OR UPDATE ON app.positions
  FOR EACH ROW EXECUTE FUNCTION app.guard_scope_sources();
CREATE TRIGGER employees_scope BEFORE INSERT OR UPDATE ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.guard_scope_sources();
CREATE TRIGGER employee_positions_scope BEFORE INSERT OR UPDATE OR DELETE ON app.employee_positions
  FOR EACH ROW EXECUTE FUNCTION app.guard_scope_sources();

-- As in 0033, plus the read committed check first (job 047 round-2 follow-up).
CREATE OR REPLACE FUNCTION app.maintain_org_closure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  own_level app.org_levels%ROWTYPE;
  parent_depth integer;
  parent_current boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned())
     AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Organisation and directory changes need a read committed transaction' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  IF NEW.parent_id IS NOT NULL AND (NEW.parent_id = NEW.id OR EXISTS (SELECT 1 FROM app.org_unit_closure c
       WHERE c.workspace_id = NEW.workspace_id AND c.ancestor_id = NEW.id AND c.descendant_id = NEW.parent_id)) THEN
    RAISE EXCEPTION 'A unit cannot be moved under itself or a unit below it' USING ERRCODE = 'RQ009';
  END IF;
  SELECT * INTO own_level FROM app.org_levels l WHERE l.id = NEW.level_id AND l.workspace_id = NEW.workspace_id;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT l.depth, u.archived_at IS NULL AND u.valid_to IS NULL INTO parent_depth, parent_current
      FROM app.org_units u JOIN app.org_levels l ON l.id = u.level_id AND l.workspace_id = u.workspace_id
      WHERE u.id = NEW.parent_id AND u.workspace_id = NEW.workspace_id;
    IF parent_depth >= own_level.depth THEN
      RAISE EXCEPTION 'A unit''s level must be below its parent''s level' USING ERRCODE = 'RQ008';
    END IF;
    IF NOT parent_current THEN
      RAISE EXCEPTION 'The parent unit is archived' USING ERRCODE = 'RQ010';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF own_level.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'The level is archived' USING ERRCODE = 'RQ010';
    END IF;
    INSERT INTO app.org_unit_closure(workspace_id, ancestor_id, descendant_id, depth)
      SELECT NEW.workspace_id, NEW.id, NEW.id, 0
      UNION ALL
      SELECT NEW.workspace_id, c.ancestor_id, NEW.id, c.depth + 1 FROM app.org_unit_closure c
        WHERE c.workspace_id = NEW.workspace_id AND c.descendant_id = NEW.parent_id;
  ELSE
    -- Unlink the moved subtree from its old ancestors, then link it below every new ancestor.
    DELETE FROM app.org_unit_closure d
      WHERE d.workspace_id = NEW.workspace_id
        AND d.descendant_id IN (SELECT s.descendant_id FROM app.org_unit_closure s
          WHERE s.workspace_id = NEW.workspace_id AND s.ancestor_id = NEW.id)
        AND d.ancestor_id NOT IN (SELECT s.descendant_id FROM app.org_unit_closure s
          WHERE s.workspace_id = NEW.workspace_id AND s.ancestor_id = NEW.id);
    INSERT INTO app.org_unit_closure(workspace_id, ancestor_id, descendant_id, depth)
      SELECT NEW.workspace_id, a.ancestor_id, s.descendant_id, a.depth + s.depth + 1
        FROM app.org_unit_closure a JOIN app.org_unit_closure s
          ON s.workspace_id = NEW.workspace_id AND s.ancestor_id = NEW.id
        WHERE a.workspace_id = NEW.workspace_id AND a.descendant_id = NEW.parent_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.maintain_org_closure() FROM PUBLIC;

-- As in 0033, plus the read committed check first.
CREATE OR REPLACE FUNCTION app.guard_org_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned())
     AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Organisation and directory changes need a read committed transaction' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM app.org_units u
      WHERE u.workspace_id = NEW.workspace_id AND u.archived_at IS NULL AND u.valid_to IS NULL
        AND CASE TG_TABLE_NAME WHEN 'org_units' THEN u.parent_id = NEW.id ELSE u.level_id = NEW.id END) THEN
    RAISE EXCEPTION 'Archive or move the units below it first' USING ERRCODE = 'RQ010';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.guard_org_archive() FROM PUBLIC;

-- One activity row per create, update and archive of a position or employee, and per change of a
-- position row, by a context of the row's workspace, written to the acting team. Metadata holds ids
-- and the sorted API names of the fields set or changed, never a value, so an erasure leaves no
-- copies. Each change app.guard_scope_sources reserves for a company owner also writes one
-- scope.home_units_changed row naming the users whose home units it can change. A security definer
-- function, so direct-SQL writes are audited too; the owner's own SQL has no context row and writes
-- nothing.
CREATE FUNCTION app.audit_directory_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
  row_workspace uuid;
  fields text[] := '{}';
  actions text[] := '{}';
  action text;
  subject jsonb;
  affected text[];
  latest uuid;
  metadata jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_context.contexts c WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned())
     AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Organisation and directory changes need a read committed transaction' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_workspace := OLD.workspace_id;
  ELSE
    row_workspace := NEW.workspace_id;
  END IF;
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.workspace_id = row_workspace;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'positions' THEN
    subject := jsonb_build_object('positionId', NEW.id);
    IF TG_OP = 'INSERT' THEN
      fields := ARRAY['code', 'isManager', 'orgUnitId', 'title'];
      IF NEW.job_role_id IS NOT NULL THEN
        fields := array_append(fields, 'jobRoleId');
      END IF;
      actions := ARRAY['org.position_created'];
      SELECT l.id INTO latest FROM (SELECT p.id, p.org_unit_id FROM app.positions p
          WHERE p.workspace_id = NEW.workspace_id AND p.code = NEW.code AND p.id <> NEW.id
          ORDER BY p.valid_from DESC, p.id DESC LIMIT 1) l
        WHERE l.org_unit_id IS DISTINCT FROM NEW.org_unit_id;
    ELSE
      IF NEW.title IS DISTINCT FROM OLD.title THEN
        fields := array_append(fields, 'title');
      END IF;
      IF NEW.code IS DISTINCT FROM OLD.code THEN
        fields := array_append(fields, 'code');
      END IF;
      IF NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id THEN
        fields := array_append(fields, 'orgUnitId');
      END IF;
      IF (NEW.job_role_team_id, NEW.job_role_id) IS DISTINCT FROM (OLD.job_role_team_id, OLD.job_role_id) THEN
        fields := array_append(fields, 'jobRoleId');
      END IF;
      IF NEW.is_manager IS DISTINCT FROM OLD.is_manager THEN
        fields := array_append(fields, 'isManager');
      END IF;
      IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
        fields := array_append(fields, 'validTo');
      END IF;
      IF cardinality(fields) > 0 THEN
        actions := ARRAY['org.position_updated'];
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := array_append(actions, 'org.position_archived');
      END IF;
      IF NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        latest := NEW.id;
      END IF;
    END IF;
    IF latest IS NOT NULL THEN
      affected := ARRAY(SELECT DISTINCT e.user_id COLLATE "C" FROM app.employee_positions ep
        JOIN app.employees e ON e.id = ep.employee_id AND e.workspace_id = ep.workspace_id
        WHERE ep.workspace_id = row_workspace AND ep.position_id = latest AND ep.valid_to IS NULL
          AND e.user_id IS NOT NULL ORDER BY 1);
    END IF;
  ELSIF TG_TABLE_NAME = 'employees' THEN
    subject := jsonb_build_object('employeeId', NEW.id);
    IF TG_OP = 'INSERT' THEN
      fields := ARRAY['displayName', 'employeeNumber', 'status'];
      IF NEW.user_id IS NOT NULL THEN
        fields := array_append(fields, 'userId');
        affected := ARRAY[NEW.user_id];
      END IF;
      IF NEW.work_email IS NOT NULL THEN
        fields := array_append(fields, 'workEmail');
      END IF;
      IF NEW.work_phone IS NOT NULL THEN
        fields := array_append(fields, 'workPhone');
      END IF;
      actions := ARRAY['directory.employee_created'];
    ELSE
      IF NEW.display_name IS DISTINCT FROM OLD.display_name THEN
        fields := array_append(fields, 'displayName');
      END IF;
      IF NEW.employee_number IS DISTINCT FROM OLD.employee_number THEN
        fields := array_append(fields, 'employeeNumber');
      END IF;
      IF NEW.work_email IS DISTINCT FROM OLD.work_email THEN
        fields := array_append(fields, 'workEmail');
      END IF;
      IF NEW.work_phone IS DISTINCT FROM OLD.work_phone THEN
        fields := array_append(fields, 'workPhone');
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        fields := array_append(fields, 'status');
      END IF;
      IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        fields := array_append(fields, 'userId');
        affected := ARRAY(SELECT DISTINCT u COLLATE "C" FROM unnest(ARRAY[OLD.user_id, NEW.user_id]) u
          WHERE u IS NOT NULL ORDER BY 1);
      END IF;
      IF cardinality(fields) > 0 THEN
        actions := ARRAY['directory.employee_updated'];
      END IF;
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        actions := array_append(actions, 'directory.employee_archived');
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      subject := jsonb_build_object('employeeId', OLD.employee_id, 'positionId', OLD.position_id);
      fields := ARRAY['positionId'];
    ELSIF TG_OP = 'INSERT' THEN
      subject := jsonb_build_object('employeeId', NEW.employee_id, 'positionId', NEW.position_id);
      fields := ARRAY['positionId', 'primary'];
    ELSE
      subject := jsonb_build_object('employeeId', NEW.employee_id, 'positionId', NEW.position_id);
      IF NEW."primary" IS DISTINCT FROM OLD."primary" THEN
        fields := array_append(fields, 'primary');
      END IF;
      IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
        fields := array_append(fields, 'validTo');
      END IF;
    END IF;
    IF cardinality(fields) > 0 THEN
      actions := ARRAY['directory.employee_positions_changed'];
      affected := ARRAY(SELECT e.user_id FROM app.employees e
        WHERE e.workspace_id = row_workspace AND e.id = (subject->>'employeeId')::uuid AND e.user_id IS NOT NULL);
    END IF;
  END IF;
  IF cardinality(affected) > 0 THEN
    actions := array_append(actions, 'scope.home_units_changed');
  END IF;
  fields := ARRAY(SELECT f COLLATE "C" FROM unnest(fields) f ORDER BY 1);
  FOREACH action IN ARRAY actions LOOP
    IF action = 'scope.home_units_changed' THEN
      metadata := jsonb_build_object('workspaceId', row_workspace, 'affectedUserIds', to_jsonb(affected))
        || CASE WHEN subject->>'employeeId' IS NULL THEN subject
          ELSE jsonb_build_object('employeeId', subject->'employeeId') END;
    ELSIF action IN ('org.position_archived', 'directory.employee_archived') THEN
      metadata := jsonb_build_object('workspaceId', row_workspace, 'fields', to_jsonb(ARRAY['archivedAt'])) || subject;
    ELSE
      metadata := jsonb_build_object('workspaceId', row_workspace, 'fields', to_jsonb(fields)) || subject;
    END IF;
    INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata)
    VALUES (ctx.team_id, NULL, ctx.actor_id, 'session', NULL, action, split_part(action, '.', 1),
      CASE action
        WHEN 'org.position_created' THEN 'Created a position'
        WHEN 'org.position_updated' THEN 'Updated a position'
        WHEN 'org.position_archived' THEN 'Archived a position'
        WHEN 'directory.employee_created' THEN 'Created an employee'
        WHEN 'directory.employee_updated' THEN 'Updated an employee'
        WHEN 'directory.employee_archived' THEN 'Archived an employee'
        WHEN 'directory.employee_positions_changed' THEN 'Changed an employee''s positions'
        ELSE 'Changed the employee facts that set home units' END,
      metadata);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.audit_directory_change() FROM PUBLIC;
CREATE TRIGGER positions_audit AFTER INSERT OR UPDATE ON app.positions
  FOR EACH ROW EXECUTE FUNCTION app.audit_directory_change();
CREATE TRIGGER employees_audit AFTER INSERT OR UPDATE ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.audit_directory_change();
CREATE TRIGGER employee_positions_audit AFTER INSERT OR UPDATE OR DELETE ON app.employee_positions
  FOR EACH ROW EXECUTE FUNCTION app.audit_directory_change();

-- Company owner sessions only (42501 otherwise, 22023 for a page size outside 1-100): the
-- scope.home_units_changed rows of every team mapped to the context's workspace, newest first, for
-- the company owners' home screen. Action, time, affected user ids and the actor's name only: no
-- team, record, token, unit, position or employee id.
CREATE FUNCTION tenant_context.home_unit_changes(before timestamptz, page_size integer)
RETURNS TABLE (occurred_at timestamptz, action text, affected_user_ids text[], actor_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ctx tenant_context.contexts%ROWTYPE;
BEGIN
  SELECT * INTO ctx FROM tenant_context.contexts c
    WHERE c.pid = pg_backend_pid() AND c.xid = pg_current_xact_id_if_assigned()
      AND c.expires_at > clock_timestamp() AND c.auth_type = 'session';
  IF NOT FOUND OR ctx.company_level IS DISTINCT FROM 'owner' OR ctx.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Home unit changes rejected' USING ERRCODE = '42501';
  END IF;
  IF home_unit_changes.page_size IS NULL OR home_unit_changes.page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Home unit changes rejected' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT a.created_at, a.action,
      ARRAY(SELECT jsonb_array_elements_text(coalesce(a.metadata->'affectedUserIds', '[]'::jsonb))), u.name
    FROM app.activity a
    JOIN app.workspace_teams t ON t.team_id = a.team_id
    LEFT JOIN auth."user" u ON u.id = a.actor_id
    WHERE a.kind = 'scope' AND a.action = 'scope.home_units_changed' AND t.workspace_id = ctx.workspace_id
      AND a.metadata->>'workspaceId' = ctx.workspace_id::text
      AND (home_unit_changes.before IS NULL OR a.created_at < home_unit_changes.before)
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT home_unit_changes.page_size;
END $$;
REVOKE ALL ON FUNCTION tenant_context.home_unit_changes(timestamptz, integer) FROM PUBLIC;

-- As in 0033, plus: directory rows and the position org rows come only from the owner
-- (app.audit_directory_change above); no runtime role inserts them directly.
DROP POLICY context_insert ON app.activity;
CREATE POLICY context_insert ON app.activity FOR INSERT WITH CHECK (
  (erasure_id IS NULL AND (
    (kind NOT IN ('api-token', 'mcp-tool', 'export', 'storage-settings', 'candidate-erasure', 'account-security', 'workspace-authority', 'config', 'org', 'scope', 'directory') AND tenant_context.allows_event(team_id, actor_id, actor_type, token_id))
    OR (kind = 'api-token' AND action IN ('token.created', 'token.revoked') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'mcp-tool' AND action IN ('mcp.tool_called', 'mcp.tool_denied', 'mcp.cv_text_read') AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'api-token' AND action = 'token.revoked' AND actor_type = 'token'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'export' AND action = 'records.exported' AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'storage-settings' AND action = 'storage.settings_updated' AND actor_type = 'session'
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'account-security' AND action = 'two_step.reset' AND actor_type = 'session'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'workspace-authority' AND action = 'workspace_authority.changed' AND actor_type = 'session' AND token_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'config' AND action IN ('config.draft_created', 'config.published', 'config.retired', 'config.archived', 'config.layout_changed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'org' AND action IN ('org.level_created', 'org.level_renamed', 'org.level_archived', 'org.unit_created',
        'org.unit_renamed', 'org.unit_moved', 'org.unit_archived', 'org.position_created', 'org.position_updated', 'org.position_archived')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'scope' AND action = 'scope.home_units_changed'
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))
    OR (kind = 'directory' AND action IN ('directory.employee_created', 'directory.employee_updated', 'directory.employee_archived',
        'directory.employee_positions_changed')
      AND actor_type = 'session' AND token_id IS NULL AND record_id IS NULL
      AND tenant_context.allows(team_id, actor_id, 'read')
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context'))))
  OR (kind = 'candidate-erasure' AND action = 'candidate.erased' AND actor_type = 'session' AND token_id IS NULL
    AND record_id IS NULL AND erasure_id IS NOT NULL AND tenant_context.allows(team_id, actor_id, 'read')
    AND current_user = (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'tenant_context')));

-- The code now depends on these tables, triggers and helpers; startup refuses a database without them.
UPDATE db_boundary.storage_schema SET version = 13;
