import { sql } from "drizzle-orm";
import {
  JOB_ARCHITECTURE_KEY,
  jobArchitectureBodySchema,
  type JobArchitectureBody,
} from "@/domain/config";
import { currentConfigBody, mayWriteConfig } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

export type JobArchitecture = {
  versionId: string;
  number: number;
  body: JobArchitectureBody;
};
export type JobArchitectureDraft = {
  id: string;
  body: Record<string, unknown>;
  note: string | null;
  createdAt: string;
};

/**
 * The company's published job architecture, read from the access state install returned; it runs
 * no statement. Null when none is published. A published body that is not a valid job architecture
 * throws, as kindSchemaFor does.
 */
export function jobArchitectureFor(
  access: Partial<Pick<TenantAccess, "documents">>,
): JobArchitecture | null {
  const current = currentConfigBody(
    access,
    "job-architecture",
    JOB_ARCHITECTURE_KEY,
  );
  if (!current) return null;
  const parsed = jobArchitectureBodySchema.safeParse(current.body);
  if (!parsed.success)
    throw new Error(
      `The published job architecture ${current.versionId} is not valid.`,
    );
  return {
    versionId: current.versionId,
    number: current.number,
    body: parsed.data,
  };
}

/**
 * Every member reads the published version (D22): names, codes and order, never pay. The draft is
 * read and returned only to those who may write it (company owners and admins with organisation,
 * signed in), and is null for everyone else.
 */
export async function getJobArchitecture(p: Principal): Promise<{
  current: JobArchitecture | null;
  draft: JobArchitectureDraft | null;
}> {
  return withTeam(p, async (tx, access) => {
    const current = jobArchitectureFor(access);
    if (!mayWriteConfig(p, access, "job-architecture"))
      return { current, draft: null };
    const { rows } = await tx.execute<{ draft: JobArchitectureDraft }>(
      sql`select jsonb_build_object('id', v.id, 'body', v.body, 'note', v.note, 'createdAt', v.created_at) as draft from app.config_objects o join app.config_versions v on v.id = o.draft_version_id and v.object_id = o.id where o.workspace_id = ${access.workspaceId}::uuid and o.team_id is null and o.type = 'job-architecture' and o.key = ${JOB_ARCHITECTURE_KEY}`,
    );
    return { current, draft: rows[0]?.draft ?? null };
  });
}

/**
 * 400 invalid_reference unless the key is a title of the published job architecture; it runs no
 * statement. The message never lists the valid keys.
 */
export function requireJobTitle(
  access: Partial<Pick<TenantAccess, "documents">>,
  key: string,
) {
  if (
    !jobArchitectureFor(access)?.body.titles.some((title) => title.key === key)
  )
    throw new ApiError(
      400,
      "invalid_reference",
      "jobTitleKey is not a job title of the published job architecture.",
    );
}
