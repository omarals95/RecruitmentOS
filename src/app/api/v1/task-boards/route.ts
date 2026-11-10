import { z } from "zod";
import { configHelpText, configKey } from "@/domain/config";
import { json, readBody, runApi } from "@/lib/api";
import { createConfigDraft, listConfigObjects } from "@/lib/config-store";
import { listTaskBoards } from "@/lib/task-boards";

export const runtime = "nodejs";
const draftSchema = z
  .object({
    key: configKey,
    body: z.unknown(),
    note: configHelpText.optional(),
  })
  .strict();
// No query, or exactly drafts=true; anything else is 400 invalid_input.
const listQuery = z
  .array(z.tuple([z.literal("drafts"), z.literal("true")]))
  .max(1);
/**
 * Signed in only. Members who may view tasks: the team's published boards, without their filters.
 * With drafts=true, team owners and admins only (403 config_forbidden otherwise): the team's
 * non-archived boards with their current and draft versions.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const query = listQuery.parse([...new URL(request.url).searchParams]);
      return json({
        data: query.length
          ? await listConfigObjects(p, "task-board")
          : await listTaskBoards(p),
      });
    },
    { humanOnly: true },
  );
}
/** A new board, or a new draft of an existing board with the same key, for the caller's team. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { key, body, note } = await readBody(request, draftSchema, 524_288);
      return json(
        {
          data: await createConfigDraft(p, {
            type: "task-board",
            key,
            body,
            note,
          }),
        },
        201,
      );
    },
    { humanOnly: true },
  );
}
