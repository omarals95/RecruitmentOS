-- Trigger functions alone may mutate the setup marker, under the migration owner.
ALTER FUNCTION auth.claim_initial_admin() SECURITY DEFINER SET search_path = pg_catalog;
ALTER FUNCTION auth.complete_initial_admin() SECURITY DEFINER SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION auth.claim_initial_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.complete_initial_admin() FROM PUBLIC;

-- Remove legacy table grants even when a deployment chose a different role name.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON auth.initial_admin_claim FROM PUBLIC;
DO $claim_grants$
DECLARE grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT roles.rolname FROM (
      SELECT claims.relowner, acl.grantee
      FROM pg_catalog.pg_class AS claims
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = claims.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(claims.relacl, pg_catalog.acldefault('r', claims.relowner))) AS acl
      WHERE namespace.nspname = 'auth' AND claims.relname = 'initial_admin_claim'
        AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
      UNION
      SELECT claims.relowner, acl.grantee
      FROM pg_catalog.pg_class AS claims
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = claims.relnamespace
      JOIN pg_catalog.pg_attribute AS column_info ON column_info.attrelid = claims.oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(column_info.attacl) AS acl
      WHERE namespace.nspname = 'auth' AND claims.relname = 'initial_admin_claim'
        AND column_info.attnum > 0 AND NOT column_info.attisdropped
        AND acl.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
    ) AS grants
    JOIN pg_catalog.pg_roles AS roles ON roles.oid = grants.grantee
    WHERE grants.grantee <> grants.relowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON auth.initial_admin_claim FROM %I CASCADE',
      grantee_name
    );
  END LOOP;
END $claim_grants$;
