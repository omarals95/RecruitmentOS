import "./load-env";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { closeDb, getIdentityDb } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { ERASURE_COUNTS, eraseCandidate } from "../src/lib/candidate-erasure";
import { ApiError } from "../src/lib/errors";
import { roleScopes } from "../src/lib/permissions";
import type { Principal } from "../src/lib/principal";

// Owner-run erasure for requests received outside the app (docs/erasure-runbook.md). It uses the
// deployment's restricted runtime connections, signed context and helper, never owner credentials.
// Every line it prints is fixed text, ids or counts: never a name, email, phone or file name.
export const USAGE =
  'Usage: npm run erase:candidate -- --team <team id or slug> --candidate <candidate id> --owner <owner email> --confirm-name "<candidate name>"';
export const REFUSED =
  "Refused: the owner email must belong to a verified owner of that team. Nothing was changed.";
export const NOT_FOUND =
  "Candidate not found in this team. Nothing was changed.";
export const MISMATCH =
  "The confirmation name does not match the candidate's name. Nothing was changed.";

const flags = ["team", "candidate", "owner", "confirm-name"] as const;
export type EraseArguments = Record<(typeof flags)[number], string>;

/** Each of the four flags exactly once with a non-empty value; anything else is null. */
export function parseEraseArguments(args: string[]): EraseArguments | null {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: Object.fromEntries(
        flags.map((flag) => [flag, { type: "string" as const }]),
      ),
    });
  } catch {
    return null;
  }
  const seen = parsed.tokens.filter((token) => token.kind === "option");
  if (seen.length !== flags.length) return null;
  const values = parsed.values as Partial<Record<string, string>>;
  if (flags.some((flag) => !values[flag]?.trim())) return null;
  return Object.fromEntries(
    flags.map((flag) => [flag, values[flag]!.trim()]),
  ) as EraseArguments;
}

/** The team by id, else by slug, and its owner by email; null unless a verified owner. */
async function resolveOwner(teamRef: string, email: string) {
  const db = await getIdentityDb();
  const [byId] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, teamRef))
    .limit(1);
  const [team] = byId
    ? [byId]
    : await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.slug, teamRef))
        .limit(1);
  const [owner] = await db
    .select({ id: user.id, verified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  if (!team || !owner?.verified) return null;
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, team.id), eq(member.userId, owner.id)))
    .limit(1);
  return membership?.role === "owner"
    ? { teamId: team.id, userId: owner.id }
    : null;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const input = parseEraseArguments(args);
  if (!input) {
    console.error(USAGE);
    return 1;
  }
  try {
    const owner = await resolveOwner(input.team, input.owner);
    if (!owner) {
      console.error(REFUSED);
      return 1;
    }
    const p: Principal = {
      ...owner,
      role: "owner",
      scopes: roleScopes("owner"),
      authType: "session",
    };
    const result = await eraseCandidate(
      p,
      input.candidate,
      { confirmName: input["confirm-name"] },
      { source: "script" },
    );
    const { deleted, waiting, deleteAfter } = result.cvStorage;
    console.log(
      [
        `Erasure id: ${result.erasureId}`,
        `Already erased: ${result.alreadyErased}`,
        result.removed
          ? `Removed: ${ERASURE_COUNTS.map(
              (name) => `${name}=${result.removed![name]}`,
            ).join(", ")}`
          : "Removed: reported by the earlier erasure only",
        `CV storage: deleted=${deleted}, waiting=${waiting}, deleteAfter=${deleteAfter ?? "none"}`,
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "";
    console.error(
      code === "not_found"
        ? NOT_FOUND
        : code === "erasure_confirmation_mismatch"
          ? MISMATCH
          : code === "invalid_input"
            ? USAGE
            : code === "erasure_forbidden"
              ? REFUSED
              : "Candidate erasure failed. Check the database connections and TENANT_CONTEXT_SIGNING_KEY; nothing about the candidate is printed.",
    );
    return 1;
  } finally {
    // An open PGlite client keeps the process alive after the work is done.
    await closeDb();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().then((code) => {
    process.exitCode = code;
  });
