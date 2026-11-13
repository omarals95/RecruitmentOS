import { taskBoardBodySchema, type TaskBoardBody } from "@/domain/config";
import {
  accessContext,
  authorize,
  hiddenKeys,
  type AccessContext,
} from "@/lib/authz";
import { withTeam } from "@/lib/db-team";
import type { Principal } from "@/lib/principal";

/** A current published task board of the caller's team; id is its configuration object's id. */
export type TaskBoard = TaskBoardBody & { id: string; key: string };

/**
 * The caller's team's current published task boards, from the documents install returned, with no
 * statement: each body the strict schema accepts, ordered by name and then key. A board whose filter
 * field the caller's role hides is left out, so a board never filters on a value the caller cannot
 * see. The built-in All buckets board is not stored, so it is never one of them.
 */
export function publishedTaskBoards(ctx: AccessContext): TaskBoard[] {
  const hidden = hiddenKeys(ctx, "task");
  return Object.values(ctx.access.documents ?? {})
    .flatMap((document) => {
      if (document.type !== "task-board") return [];
      const parsed = taskBoardBodySchema.safeParse(document.body);
      if (!parsed.success) return [];
      const { filter } = parsed.data;
      if (filter?.by === "field" && hidden.has(filter.fieldId)) return [];
      return [{ id: document.objectId, key: document.key, ...parsed.data }];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * GET /api/v1/task-boards: the published boards for any member who may view tasks, in the one
 * withTeam transaction and no statement of its own. The filter is never returned.
 */
export async function listTaskBoards(
  p: Principal,
): Promise<Pick<TaskBoard, "id" | "key" | "name" | "columns">[]> {
  return withTeam(p, async (_tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "tasks", action: "view" });
    return publishedTaskBoards(ctx).map(({ id, key, name, columns }) => ({
      id,
      key,
      name,
      columns,
    }));
  });
}
