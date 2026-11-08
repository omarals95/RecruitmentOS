import { ApiError } from "../lib/errors";

/**
 * The storage reference, ledger, Blob read-lease, team limit, Blob charge release, PUT ticket count,
 * cleanup cooldown, candidate erasure, MCP CV text setting, company workspace, three-argument
 * tenant context, versioned configuration store, explicit scope ceiling and configuration versions
 * through install schema this code was written for (`0032_config_versions_install.sql`).
 */
export const STORAGE_SCHEMA_VERSION = 11;

/** Refuse to serve when the owner-controlled storage marker is missing or another version. */
export async function assertStorageSchema(client: {
  query: (query: string) => Promise<{ rows: unknown[] }>;
}): Promise<void> {
  let rows: unknown[] | undefined;
  try {
    rows = (
      await client.query("SELECT version FROM db_boundary.storage_schema")
    )?.rows;
  } catch {
    rows = undefined;
  }
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    (rows[0] as { version?: unknown } | null)?.version !==
      STORAGE_SCHEMA_VERSION
  )
    throw new ApiError(
      503,
      "storage_schema_mismatch",
      "The database storage schema does not match this release. Apply the reviewed migrations before serving CVs.",
    );
}
