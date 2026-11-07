import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import { member, user } from "../src/db/auth-schema";
import { activity } from "../src/db/schema";
import { withTeam } from "../src/lib/db-team";
import { listActivity } from "../src/lib/insights";
import type { Principal } from "../src/lib/principal";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

describe("activity actor names under a data-only role", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, colleague: Principal, former: Principal;
  let other: Principal;
  const ids = {
    former: randomUUID(),
    colleaguePrivate: randomUUID(),
    colleagueView: randomUUID(),
    foreign: randomUUID(),
  };
  const event = (p: Principal, id: string, action: string, kind: string) => ({
    id,
    teamId: p.teamId,
    actorId: p.userId,
    actorType: "session",
    action,
    kind,
    summary: `Fictional ${action} event`,
  });
  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockRejectedValue(
      new Error("Activity listing must not use the identity pool."),
    );
    const db = await harness.asOwner();
    owner = await seedIdentity(db, { userId: "fixture-user" });
    colleague = await seedIdentity(db, {
      userId: "fixture-colleague",
      role: "recruiter",
    });
    former = await seedIdentity(db, {
      userId: "fixture-former",
      role: "recruiter",
    });
    other = await seedIdentity(db, {
      userId: "fixture-other",
      teamId: "fixture-other-team",
    });
    await db
      .update(user)
      .set({ name: "Historical Fictional Actor" })
      .where(eq(user.id, former.userId));
    await withTeam(former, (tx) =>
      tx.insert(activity).values(event(former, ids.former, "created", "task")),
    );
    await withTeam(colleague, (tx) =>
      tx
        .insert(activity)
        .values([
          event(
            colleague,
            ids.colleaguePrivate,
            "personal_state_updated",
            "candidate",
          ),
          event(colleague, ids.colleagueView, "created", "saved-view"),
        ]),
    );
    await withTeam(other, (tx) =>
      tx.insert(activity).values(event(other, ids.foreign, "created", "task")),
    );
    await (
      await harness.asOwner()
    )
      .delete(member)
      .where(
        and(
          eq(member.organizationId, former.teamId),
          eq(member.userId, former.userId),
        ),
      );
  });
  afterAll(async () => harness?.close());

  it("returns actor names, including a former member's, without identity access", async () => {
    await harness.dataDb();
    await expect(
      harness.client.query('SELECT name FROM auth."user"'),
    ).rejects.toMatchObject({ code: "42501" });
    const result = await listActivity(owner, new URLSearchParams());
    expect(result.data).toEqual([
      expect.objectContaining({
        id: ids.former,
        actorId: former.userId,
        actorName: "Historical Fictional Actor",
      }),
    ]);
    const searched = await listActivity(
      owner,
      new URLSearchParams({ search: "historical fictional" }),
    );
    expect(searched.pagination.total).toBe(1);
    expect(searched.data[0].id).toBe(ids.former);
    expect(
      (
        await listActivity(
          owner,
          new URLSearchParams({ search: "Fictional Test User" }),
        )
      ).pagination.total,
    ).toBe(0);
    expect(pools.identity).not.toHaveBeenCalled();
  });

  it("resolves no name for events outside the team or the caller's private visibility", async () => {
    const names = await withTeam(owner, async (tx) => {
      const resolved: Record<string, string | null> = {};
      for (const [label, id] of Object.entries(ids)) {
        const { rows } = await tx.execute<{ name: string | null }>(
          sql`select tenant_context.activity_actor_name(${id}::uuid) as name`,
        );
        resolved[label] = rows[0].name;
      }
      return resolved;
    });
    expect(names).toEqual({
      former: "Historical Fictional Actor",
      colleaguePrivate: null,
      colleagueView: null,
      foreign: null,
    });
    const own = await listActivity(colleague, new URLSearchParams());
    expect(own.data.map((row) => [row.id, row.actorName]).sort()).toEqual(
      [
        [ids.colleaguePrivate, "Fictional Test User"],
        [ids.colleagueView, "Fictional Test User"],
        [ids.former, "Historical Fictional Actor"],
      ].sort(),
    );
  });
});
