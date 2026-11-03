/** Reject roles that own protected objects or can assume a broadly privileged role. */
export const runtimeRoleSafetyQuery = `
  SELECT (
    (SELECT count(*) FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('app', 'auth')) <> 2
    OR
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
      WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
          OR r.rolname IN ('neon_superuser', 'pg_read_all_data', 'pg_write_all_data',
            'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))
    )
    -- Defense in depth for known filesystem helpers; this is not a full catalog audit.
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'pg_catalog'
        AND p.proname IN ('pg_read_file', 'pg_read_binary_file', 'pg_ls_dir',
          'pg_stat_file', 'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_archive_statusdir',
          'pg_ls_tmpdir', 'pg_ls_logicalmapdir', 'pg_ls_logicalsnapdir',
          'pg_ls_replslotdir', 'pg_ls_summariesdir', 'pg_rotate_logfile',
          'lo_import', 'lo_export')
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE')
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname IN ('app', 'auth')
        AND (pg_catalog.pg_has_role(current_user, n.nspowner, 'MEMBER')
          OR pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE'))
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('app', 'auth')
        AND pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('app', 'auth')
        AND pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER')
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'auth' AND c.relname = 'initial_admin_claim'
        AND c.relkind IN ('r', 'p')
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'auth' AND c.relname = 'initial_admin_claim'
        AND c.relkind IN ('r', 'p')
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES'))
    )
    OR pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE')
  ) AS unsafe
`;
