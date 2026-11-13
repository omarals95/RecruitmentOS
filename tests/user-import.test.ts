import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads accounts,
// memberships and invitations and runs Better Auth, the data role runs withTeam. Only one PGlite role
// is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
// The apply route's Better Auth is the test instance, with the fake mail array.
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  getAuth: vi.fn(),
}));
// The real parser, wrapped so a test can see whether it ran.
vi.mock("read-excel-file/node", async (original) => {
  const actual = await original<typeof import("read-excel-file/node")>();
  return { ...actual, default: vi.fn(actual.default) };
});

import readXlsx from "read-excel-file/node";
import writeXlsx from "write-excel-file/node";
import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { member } from "@/db/auth-schema";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { XLSX_TYPE } from "@/domain/org";
import { getAuth } from "@/lib/auth";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import {
  addGroupManager,
  addGroupMember,
  archiveGroup,
  createGroup,
  grantGroupRole,
  setGroupApproval,
  type Group,
} from "@/lib/groups";
import { listActivity } from "@/lib/insights";
import { roleScopes, type Role } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import { POST as dryRunRoute } from "@/app/api/v1/admin/users/import/dry-run/route";
import { POST as applyRoute } from "@/app/api/v1/admin/users/import/apply/route";
import {
  addMember,
  authCaller,
  createTestAuth,
  setUpAdmin,
  type Mail,
} from "./helpers/auth";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with fictional teams, people and groups, a second
// fictional company, and fictional workbooks built here (ADM-15, IAM-004). Mail reaches only the
// fake deliver of the test Better Auth instance.
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000104";
const ORIGIN = "http://localhost:3000";
const COLUMNS = ["Email", "Team", "Team role", "Group"];
const STALE = 16 * 60 * 1000;
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Cell = string | number | boolean | Date | null;

/** A fictional .xlsx workbook of one sheet; the first row is its header. */
async function workbook(rows: Cell[][], header: Cell[] = COLUMNS) {
  return writeXlsx([
    {
      sheet: "People",
      data: [header, ...rows].map((row) =>
        row.map((value) =>
          value === null
            ? null
            : value instanceof Date
              ? { value, format: "yyyy-mm-dd" }
              : { value },
        ),
      ),
    },
  ]).toBuffer();
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const conflictSentence = (people: string, team: string) =>
  `This would give ${people} two roles in ${team}. A person holds one configured role per team: remove them from one of the groups, or choose their role in the team's Members tab.`;

describe("bulk invite and group add from a workbook", () => {
  let harness: Harness;
  const mail: Mail[] = [];
  const cookies = new Map<string, string>();
  let owner: Principal, peopleAdmin: Principal, viewerAdmin: Principal;
  let fieldsAdmin: Principal, teamOwner: Principal, manager: Principal;
  let pat: Principal, quinn: Principal, rana: Principal, sami: Principal;
  let ownerX: Principal;
  let alpha = "";
  const groups = {} as Record<
    | "notify"
    | "roleOne"
    | "roleTwo"
    | "approvers"
    | "nested"
    | "old"
    | "elsewhere",
    Group
  >;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to arrange and inspect. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const count = async (text: string, params: unknown[] = []) =>
    Number((await look<{ count: string }>(text, params))[0].count);
  /** Every row an import could touch, and the mail sent. */
  const state = async () => ({
    invitations: await look(
      "SELECT organization_id, email, role, status FROM auth.invitation ORDER BY organization_id, email",
    ),
    members: await look(
      "SELECT group_id, user_id, child_group_id FROM app.group_members ORDER BY group_id, user_id, child_group_id",
    ),
    activity: await count("SELECT count(*) FROM app.activity"),
    teamMembers: await look(
      "SELECT organization_id, user_id, role FROM auth.member ORDER BY organization_id, user_id",
    ),
    memberRoles: await look(
      "SELECT team_id, user_id, role_object_id FROM app.member_roles ORDER BY team_id, user_id",
    ),
    authority: await look(
      "SELECT workspace_id, user_id, level, areas, plan_access FROM app.workspace_admins ORDER BY workspace_id, user_id",
    ),
    mail: mail.length,
  });
  const directMembers = async (groupId: string) =>
    (
      await look<{ user_id: string }>(
        "SELECT user_id FROM app.group_members WHERE group_id = $1 AND user_id IS NOT NULL ORDER BY user_id",
        [groupId],
      )
    ).map((row) => row.user_id);
  const invited = async (teamId: string) =>
    (
      await look<{ email: string; role: string }>(
        "SELECT email, role FROM auth.invitation WHERE organization_id = $1 AND status = 'pending' ORDER BY email",
        [teamId],
      )
    ).map((row) => `${row.email}:${row.role}`);
  const importRows = () =>
    look<{
      team_id: string;
      actor_id: string;
      actor_type: string;
      token_id: string | null;
      record_id: string | null;
      action: string;
      summary: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT team_id, actor_id, actor_type, token_id, record_id, action, summary, metadata FROM app.activity WHERE kind = 'user-import' ORDER BY created_at, id",
    );
  /** One data-role transaction under the principal's verified context. */
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows;
      }),
    );

  /** One import request, as a signed-in member (fresh unless stale) or with a Bearer token. */
  async function post(
    route: "dry-run" | "apply",
    body: Uint8Array,
    options: {
      as?: Principal;
      stale?: boolean;
      bearer?: string;
      query?: string;
      type?: string;
    },
  ) {
    const as = options.as;
    if (as) {
      const [row] = await look<{ name: string; email: string }>(
        `SELECT name, email FROM auth."user" WHERE id = $1`,
        [as.userId],
      );
      vi.mocked(getVerifiedSession).mockResolvedValue({
        user: {
          id: as.userId,
          name: row.name,
          email: row.email,
          emailVerified: true,
          twoFactorEnabled: true,
        },
        session: {
          activeOrganizationId: as.teamId,
          createdAt: new Date(Date.now() - (options.stale ? STALE : 0)),
        },
      } as never);
    }
    const cookie = as ? cookies.get(as.userId) : undefined;
    const response = await (route === "dry-run" ? dryRunRoute : applyRoute)(
      new Request(
        `${ORIGIN}/api/v1/admin/users/import/${route}${options.query ?? ""}`,
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": options.type ?? XLSX_TYPE,
            ...(as ? { "x-team-id": as.teamId } : {}),
            ...(cookie ? { cookie } : {}),
            ...(options.bearer
              ? { authorization: `Bearer ${options.bearer}` }
              : {}),
          },
          body: new Uint8Array(body),
        },
      ),
    );
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await response.json()) as any,
    };
  }
  const dryRun = (body: Uint8Array, as: Principal, stale = false) =>
    post("dry-run", body, { as, stale });
  const apply = (
    body: Uint8Array,
    as: Principal,
    group?: "owner",
    stale = false,
  ) =>
    post("apply", body, {
      as,
      stale,
      query: `?sha256=${sha(body)}${group ? `&group=${group}` : ""}`,
    });
  /** Expects one refusal on the route, with no row of any import table changed and no mail. */
  async function refused(
    call: () => ReturnType<typeof post>,
    status: number,
    code: string,
  ) {
    const before = await state();
    const response = await call();
    expect([response.status, response.body.error?.code]).toEqual([
      status,
      code,
    ]);
    expect(await state()).toEqual(before);
    return response;
  }
  const session = (userId: string, teamId: string, role: Role): Principal => ({
    userId,
    teamId,
    role,
    scopes: roleScopes(role),
    authType: "session",
    sessionCreatedAt: new Date(),
  });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    // The company owner and a team admin with the people area sign in through Better Auth, so
    // apply's invitations run with their own cookies; everyone else is seeded.
    const auth = createTestAuth(await harness.identityDb(), mail);
    vi.mocked(getAuth).mockResolvedValue(auth);
    const caller = authCaller(auth);
    const admin = await setUpAdmin(caller, mail);
    alpha = admin.teamId;
    await harness.identityDb();
    const added = await addMember(
      caller,
      mail,
      admin.cookie,
      alpha,
      "ui-people-admin@example.test",
      "admin",
    );
    const idOf = async (email: string) =>
      (
        await look<{ id: string }>(
          `SELECT id FROM auth."user" WHERE email = $1`,
          [email],
        )
      )[0].id;
    owner = session(await idOf("owner@example.test"), alpha, "owner");
    peopleAdmin = session(
      await idOf("ui-people-admin@example.test"),
      alpha,
      "admin",
    );
    cookies.set(owner.userId, admin.cookie);
    cookies.set(peopleAdmin.userId, added.cookie);

    const db: AppDb = await harness.asOwner();
    const seed = async (userId: string, teamId: string, role: Role) =>
      session(
        (await seedIdentity(db, { userId, teamId, role })).userId,
        teamId,
        role,
      );
    viewerAdmin = await seed("ui-viewer-admin", alpha, "viewer");
    fieldsAdmin = await seed("ui-fields-admin", alpha, "admin");
    manager = await seed("ui-manager", alpha, "recruiter");
    pat = await seed("ui-pat", alpha, "recruiter");
    quinn = await seed("ui-quinn", alpha, "recruiter");
    rana = await seed("ui-rana", alpha, "recruiter");
    sami = await seed("ui-sami", alpha, "recruiter");
    teamOwner = await seed("ui-team-owner", "ui-solo", "owner");
    // The company owner owns Beta, Archived and both Twins, is admin of Gamma and recruiter of Rec.
    for (const team of ["ui-beta", "ui-archived", "ui-twin-1", "ui-twin-2"])
      await seedIdentity(db, { userId: owner.userId, teamId: team });
    await seed("ui-gamma-owner", "ui-gamma", "owner");
    await seed("ui-rec-owner", "ui-rec", "owner");
    // Memberships of teams others created, as Better Auth stores an accepted invitation.
    for (const [userId, teamId, role] of [
      [owner.userId, "ui-gamma", "admin"],
      [owner.userId, "ui-rec", "recruiter"],
      [peopleAdmin.userId, "ui-rec", "recruiter"],
    ])
      await db
        .insert(member)
        .values({
          id: `${userId}:${teamId}`,
          organizationId: teamId,
          userId,
          role,
        });
    ownerX = await seed("ui-else-owner", "ui-elsewhere", "owner");
    await seed("ui-else-person", "ui-elsewhere", "recruiter");
    // Names, company authority, an archived team, a pending invitation and the second company; no
    // team is created after this.
    await harness.asSuperuser();
    await harness.client.exec(`
      UPDATE auth.organization SET name = 'Fictional Alpha' WHERE id = '${alpha}';
      UPDATE auth.organization SET name = 'Fictional Beta' WHERE id = 'ui-beta';
      UPDATE auth.organization SET name = 'Fictional Archived' WHERE id = 'ui-archived';
      UPDATE auth.organization SET name = 'Fictional Twin' WHERE id IN ('ui-twin-1', 'ui-twin-2');
      UPDATE auth.organization SET name = 'Fictional Gamma' WHERE id = 'ui-gamma';
      UPDATE auth.organization SET name = 'Fictional Rec' WHERE id = 'ui-rec';
      UPDATE auth.organization SET name = 'Fictional Solo' WHERE id = 'ui-solo';
      UPDATE auth.organization SET name = 'Fictional Elsewhere' WHERE id = 'ui-elsewhere';
      UPDATE auth."user" SET name = 'Fictional Pat' WHERE id = 'ui-pat';
      UPDATE auth."user" SET name = 'Fictional Quinn' WHERE id = 'ui-quinn';
      UPDATE auth."user" SET name = 'Fictional Rana' WHERE id = 'ui-rana';
      UPDATE auth."user" SET name = 'Fictional Sami' WHERE id = 'ui-sami';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','${peopleAdmin.userId}','admin','{people}'),
        ('${COMPANY}','ui-viewer-admin','admin','{people}'),
        ('${COMPANY}','ui-fields-admin','admin','{fields}');
      UPDATE app.workspace_teams SET archived_at = now(), archived_by = '${owner.userId}' WHERE team_id = 'ui-archived';
      INSERT INTO auth.invitation(id, organization_id, email, role, status, expires_at, inviter_id)
        VALUES ('ui-pending', 'ui-beta', 'pending@example.test', 'viewer', 'pending', now() + interval '2 days', '${owner.userId}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'ui-elsewhere';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','ui-else-owner','owner');
    `);
    // Two published fictional roles, and the groups.
    const publish = async (key: string, name: string) => {
      await harness.dataDb();
      const { objectId, versionId } = await createConfigDraft(owner, {
        type: "role",
        key,
        body: { ...structuredClone(RECRUITER_ROLE.body), name },
      });
      await harness.dataDb();
      await publishConfigVersion(owner, versionId);
      return objectId;
    };
    const roleOne = await publish("ui-role-one", "Fictional Role One");
    const roleTwo = await publish("ui-role-two", "Fictional Role Two");
    const create = (name: string) => createGroup(owner, { name });
    groups.notify = await create("Fictional Notify");
    groups.roleOne = await create("Fictional Role Group");
    groups.roleTwo = await create("Fictional Role Two");
    groups.approvers = await create("Fictional Approvers");
    groups.nested = await create("Fictional Nested");
    groups.old = await create("Fictional Old");
    await addGroupManager(owner, groups.notify.id, { userId: manager.userId });
    await addGroupMember(owner, groups.roleOne.id, { userId: rana.userId });
    await addGroupMember(owner, groups.roleOne.id, {
      childGroupId: groups.nested.id,
    });
    await grantGroupRole(owner, groups.roleOne.id, {
      teamId: alpha,
      roleObjectId: roleOne,
    });
    await grantGroupRole(owner, groups.roleTwo.id, {
      teamId: alpha,
      roleObjectId: roleTwo,
    });
    await setGroupApproval(owner, groups.approvers.id, { approval: true });
    await archiveGroup(owner, groups.old.id);
    groups.elsewhere = await createGroup(ownerX, {
      name: "Fictional Elsewhere Group",
    });
    await addGroupMember(ownerX, groups.elsewhere.id, {
      userId: ownerX.userId,
    });
  });
  afterAll(async () => harness?.close());

  /** The main fictional workbook: rows to send, add, leave for an owner and refuse for each reason. */
  const main = () =>
    workbook([
      ["new1@example.test", "Fictional Alpha", "Recruiter", null],
      ["NEW1@example.test", "fictional alpha", "viewer", null],
      ["new2@example.test", "Fictional Beta", "Admin", "Fictional Notify"],
      ["not-an-email", "Fictional Alpha", "Viewer", null],
      ["new3@example.test", "Fictional Nowhere", "Viewer", null],
      ["new3@example.test", "Fictional Archived", "Viewer", null],
      ["new3@example.test", "Fictional Rec", "Viewer", null],
      ["new3@example.test", "Fictional Gamma", "Owner", null],
      ["new3@example.test", "Fictional Twin", "Viewer", null],
      [
        "ui-pat@example.test",
        "Fictional Alpha",
        "Recruiter",
        "Fictional Role Group",
      ],
      ["ui-pat@example.test", null, null, "Fictional Approvers"],
      ["ui-pat@example.test", null, null, "Fictional Nested"],
      ["ui-quinn@example.test", null, null, "Fictional Notify"],
      ["UI-Quinn@example.test", null, null, "fictional notify"],
      ["ui-quinn@example.test", null, null, "Fictional Nowhere Group"],
      ["ui-quinn@example.test", null, null, "Fictional Old"],
      ["ui-quinn@example.test", null, null, "All members"],
      ["ui-rana@example.test", null, null, "Fictional Role Two"],
      [
        "ui-quinn@example.test",
        "Fictional Elsewhere",
        "Viewer",
        "Fictional Elsewhere Group",
      ],
      ["ui-else-person@example.test", null, null, "Fictional Notify"],
      ["pending@example.test", "Fictional Beta", "Viewer", null],
      ["new4@example.test", "Fictional Alpha", null, null],
      ["new5@example.test", null, null, null],
      [null, null, null, null],
    ]);
  const MAIN_REFUSED = [
    {
      row: 3,
      part: "invitation",
      reason: "Duplicate of row 2: the same email and team.",
    },
    {
      row: 4,
      part: "group",
      reason:
        "new2@example.test is not in a team of the company yet. Apply the same file again after they accept their invitation.",
    },
    {
      row: 5,
      part: "row",
      reason: '"not-an-email" is not a valid email address.',
    },
    {
      row: 6,
      part: "invitation",
      reason: 'No team of the company is named "Fictional Nowhere".',
    },
    {
      row: 7,
      part: "invitation",
      reason: 'The team "Fictional Archived" is archived.',
    },
    {
      row: 8,
      part: "invitation",
      reason:
        "You can invite people only to teams where you are an owner or admin.",
    },
    {
      row: 9,
      part: "invitation",
      reason:
        'You cannot give the team role "Owner" in Fictional Gamma; choose Admin, Recruiter or Viewer.',
    },
    {
      row: 10,
      part: "invitation",
      reason:
        'The name "Fictional Twin" is used by more than one team, so the team cannot be told apart.',
    },
    {
      row: 15,
      part: "group",
      reason: "Duplicate of row 14: the same email and group.",
    },
    {
      row: 16,
      part: "group",
      reason: 'No group of the company is named "Fictional Nowhere Group".',
    },
    {
      row: 17,
      part: "group",
      reason: 'The group "Fictional Old" is archived.',
    },
    {
      row: 18,
      part: "group",
      reason:
        '"All members" is a computed group: it is read-only, so you cannot add people to it.',
    },
    {
      row: 19,
      part: "group",
      reason: conflictSentence("Fictional Rana", "Fictional Alpha"),
    },
    {
      row: 20,
      part: "invitation",
      reason: 'No team of the company is named "Fictional Elsewhere".',
    },
    {
      row: 20,
      part: "group",
      reason: 'No group of the company is named "Fictional Elsewhere Group".',
    },
    {
      row: 21,
      part: "group",
      reason:
        "ui-else-person@example.test is not in a team of the company yet. Apply the same file again after they accept their invitation.",
    },
    {
      row: 23,
      part: "invitation",
      reason: "Team role is blank: give the team role to invite them with.",
    },
    {
      row: 24,
      part: "row",
      reason: "Team, Team role and Group are all blank.",
    },
  ];
  const MAIN_NEEDS_OWNER = [11, 12, 13].map((row, i) => ({
    row,
    part: "group",
    reason: `Adds ui-pat@example.test to "${["Fictional Role Group", "Fictional Approvers", "Fictional Nested"][i]}", which gives a role or approvals, itself or through a group it is in.`,
  }));

  it("dry-runs with counts and a plain-words reason per refused part, and writes nothing, for a session of any age", async () => {
    const file = await main();
    for (const stale of [false, true]) {
      const before = await state();
      const response = await dryRun(file, owner, stale);
      expect(response.status, String(stale)).toBe(200);
      expect(response.body.data).toEqual({
        sha256: sha(file),
        counts: {
          invite: 2,
          alreadyDone: 2,
          groupAdd: 1,
          needsOwner: 3,
          refused: 18,
        },
        refused: MAIN_REFUSED,
        needsOwner: MAIN_NEEDS_OWNER,
        flagged: [],
        ignored: [],
        truncated: false,
      });
      // No invitation, group member, audit row or mail.
      expect(await state()).toEqual(before);
    }
  });

  it("refuses oversized, unsafe, unreadable and malformed workbooks before any row is read, after only the caller check", async () => {
    const parsed = vi.mocked(readXlsx);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    // 2,001 central directory entries, declared before anything is expanded.
    const records = Array.from({ length: 2_001 }, (_, i) => {
      const name = Buffer.from(`xl/fictional-${i}.xml`);
      const record = Buffer.alloc(46 + name.length);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt32LE(1, 20);
      record.writeUInt32LE(10, 24);
      record.writeUInt16LE(name.length, 28);
      name.copy(record, 46);
      return record;
    });
    const directory = Buffer.concat(records);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(2_001, 8);
    end.writeUInt16LE(2_001, 10);
    end.writeUInt32LE(directory.length, 12);
    const crowded = Buffer.concat([directory, end]);
    for (const route of ["dry-run", "apply"] as const) {
      const limited = async (
        file: Buffer,
        status: number,
        code: string,
        type?: string,
      ) => {
        parsed.mockClear();
        pools.data.mockClear();
        const response = await refused(
          () =>
            post(route, file, {
              as: owner,
              type,
              query: `?sha256=${sha(file)}`,
            }),
          status,
          code,
        );
        expect(parsed, code).not.toHaveBeenCalled();
        expect(pools.data, code).toHaveBeenCalledTimes(1);
        return response;
      };
      expect(
        (await limited(big, 413, "import_too_large")).body.error.message,
      ).toContain("5 MiB");
      await limited(crowded, 422, "import_archive_too_large");
      await limited(await main(), 415, "xlsx_required", "text/csv");
      await limited(Buffer.from("not a workbook"), 422, "import_unreadable");
      // Parsed, but refused before any read of people, teams or groups.
      const header = async (file: Buffer, status: number, code: string) => {
        pools.data.mockClear();
        const response = await refused(
          () => post(route, file, { as: owner, query: `?sha256=${sha(file)}` }),
          status,
          code,
        );
        expect(pools.data, code).toHaveBeenCalledTimes(1);
        return response;
      };
      expect(
        (
          await header(
            await workbook(
              [["ui-pat@example.test", "Fictional Alpha", "Viewer"]],
              ["Email", "Team", "Team role"],
            ),
            422,
            "import_columns_missing",
          )
        ).body.error.message,
      ).toBe(
        "Row 1 of the first sheet names the columns Email, Team, Team role and Group, and it has no Group column.",
      );
      await header(
        await workbook([[null, null, null, null]]),
        422,
        "import_empty",
      );
      const many = await workbook(
        Array.from({ length: 20_001 }, (_, i) => [
          `row-${i}@example.test`,
          null,
          null,
          "Fictional Notify",
        ]),
      );
      expect(
        (await header(many, 422, "import_too_many_rows")).body.error.message,
      ).toContain("20,000");
    }
  }, 120_000);

  it("applies only the file the dry run checked and refuses any other query", async () => {
    const file = await main();
    const other = await workbook([
      ["new9@example.test", "Fictional Alpha", "Viewer", null],
    ]);
    await refused(
      () => post("apply", other, { as: owner, query: `?sha256=${sha(file)}` }),
      409,
      "import_file_changed",
    );
    for (const query of [
      "",
      "?sha256=abc",
      `?sha256=${sha(file)}&group=everyone`,
      `?sha256=${sha(file)}&team=${alpha}`,
      `?sha256=${sha(file)}&sha256=${sha(file)}`,
    ])
      await refused(
        () => post("apply", file, { as: owner, query }),
        400,
        "invalid_input",
      );
  });

  it("refuses tokens, team owners without company authority, company admins without people and delegated managers on both routes", async () => {
    const file = await main();
    for (const route of ["dry-run", "apply"] as const) {
      const query = `?sha256=${sha(file)}`;
      await refused(
        () => post(route, file, { bearer: "ros_live_fictional", query }),
        403,
        "session_required",
      );
      for (const as of [teamOwner, fieldsAdmin, manager])
        await refused(
          () => post(route, file, { as, query }),
          403,
          "people_forbidden",
        );
    }
    // A company admin with people whose current team role cannot be recorded checks but never applies.
    expect((await dryRun(file, viewerAdmin)).status).toBe(200);
    const forbidden = await refused(
      () => apply(file, viewerAdmin),
      403,
      "user_import_forbidden",
    );
    expect(forbidden.body.error.message).toContain(
      "change candidates, recruitment, CVs or imports",
    );
  });

  it("needs a recent sign-in to apply and for the owner step, and writes nothing without one", async () => {
    const file = await main();
    for (const group of [undefined, "owner"] as const)
      await refused(
        () => apply(file, owner, group, true),
        403,
        "SESSION_NOT_FRESH",
      );
  });

  it("invites only to the caller's owner and admin teams with the roles they may give, and leaves granting groups to a company owner", async () => {
    const file = await workbook([
      ["pa-new1@example.test", "Fictional Alpha", "Recruiter", null],
      ["pa-new2@example.test", "Fictional Alpha", "Owner", null],
      ["pa-new3@example.test", "Fictional Rec", "Viewer", null],
      ["pa-new4@example.test", "Fictional Beta", "Viewer", null],
      ["pa-new5@example.test", "Fictional Archived", "Viewer", null],
      ["pa-new6@example.test", "Fictional Elsewhere", "Viewer", null],
      ["ui-sami@example.test", null, null, "Fictional Role Group"],
      ["ui-sami@example.test", null, null, "Fictional Approvers"],
      ["ui-sami@example.test", null, null, "Fictional Nested"],
      ["ui-sami@example.test", null, null, "Fictional Notify"],
    ]);
    const before = await state();
    const sent = mail.length;
    const response = await apply(file, peopleAdmin);
    expect(response.status).toBe(200);
    expect(response.body.data.group).toBe("normal");
    expect(response.body.data.counts).toEqual({
      invite: 1,
      alreadyDone: 0,
      groupAdd: 1,
      needsOwner: 3,
      refused: 5,
    });
    expect(
      response.body.data.refused.map(
        (entry: { row: number; reason: string }) =>
          `${entry.row}: ${entry.reason}`,
      ),
    ).toEqual([
      '3: You cannot give the team role "Owner" in Fictional Alpha; choose Admin, Recruiter or Viewer.',
      "4: You can invite people only to teams where you are an owner or admin.",
      "5: You can invite people only to teams where you are an owner or admin.",
      '6: The team "Fictional Archived" is archived.',
      '7: No team of the company is named "Fictional Elsewhere".',
    ]);
    expect(
      response.body.data.needsOwner.map((entry: { row: number }) => entry.row),
    ).toEqual([8, 9, 10]);
    // One invitation, to Alpha, with one mail to the fake deliver only.
    expect(mail.slice(sent).map((item) => item.to)).toEqual([
      "pa-new1@example.test",
    ]);
    const after = await state();
    expect(after.invitations.length).toBe(before.invitations.length + 1);
    expect(await invited(alpha)).toContain("pa-new1@example.test:recruiter");
    for (const team of ["ui-rec", "ui-beta", "ui-archived", "ui-elsewhere"])
      expect(
        (await invited(team)).filter((entry) => entry.startsWith("pa-")),
        team,
      ).toEqual([]);
    // Sami is in Notify, and in none of the granting groups.
    expect(await directMembers(groups.notify.id)).toContain(sami.userId);
    for (const group of [groups.roleOne, groups.approvers, groups.nested])
      expect(await directMembers(group.id), group.name).not.toContain(
        sami.userId,
      );
    // The owner step is the company owner's alone; the database refuses the insert as well.
    await refused(
      () => apply(file, peopleAdmin, "owner"),
      403,
      "group_owner_required",
    );
    for (const group of [groups.roleOne, groups.approvers, groups.nested])
      await expect(
        sqlAs(
          peopleAdmin,
          `INSERT INTO app.group_members(group_id, workspace_id, user_id) VALUES ('${group.id}', '${COMPANY}', '${sami.userId}')`,
        ),
        group.name,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    // The company owner's own normal apply leaves them too; the owner step adds exactly them.
    const granting = await workbook([
      ["ui-sami@example.test", null, null, "Fictional Role Group"],
      ["ui-sami@example.test", null, null, "Fictional Approvers"],
      ["ui-sami@example.test", null, null, "Fictional Nested"],
    ]);
    const normal = await apply(granting, owner);
    expect(normal.body.data.counts).toEqual({
      invite: 0,
      alreadyDone: 0,
      groupAdd: 0,
      needsOwner: 3,
      refused: 0,
    });
    for (const group of [groups.roleOne, groups.approvers, groups.nested])
      expect(await directMembers(group.id), group.name).not.toContain(
        sami.userId,
      );
    const step = await apply(file, owner, "owner");
    expect(step.status).toBe(200);
    expect(step.body.data).toMatchObject({
      group: "owner",
      counts: { invite: 0, groupAdd: 3, needsOwner: 0 },
      needsOwner: [],
    });
    for (const group of [groups.roleOne, groups.approvers, groups.nested])
      expect(await directMembers(group.id), group.name).toContain(sami.userId);
  });

  it("applies the main workbook, is idempotent by email and team and by email and group, and audits with ids and counts only", async () => {
    const file = await main();
    const beforeMembers = (await state()).members.length;
    const sent = mail.length;
    const beforeImports = (await importRows()).length;
    const memberAdds = await count(
      "SELECT count(*) FROM app.activity WHERE action = 'group.member_added'",
    );
    const first = await apply(file, owner);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      sha256: sha(file),
      group: "normal",
      counts: {
        invite: 2,
        alreadyDone: 2,
        groupAdd: 1,
        needsOwner: 3,
        refused: 18,
      },
      refused: MAIN_REFUSED,
      needsOwner: MAIN_NEEDS_OWNER,
      flagged: [],
      ignored: [],
      truncated: false,
    });
    expect(mail.slice(sent).map((item) => item.to)).toEqual([
      "new1@example.test",
      "new2@example.test",
    ]);
    expect(await invited(alpha)).toContain("new1@example.test:recruiter");
    expect(await invited("ui-beta")).toEqual([
      "new2@example.test:admin",
      "pending@example.test:viewer",
    ]);
    expect(await directMembers(groups.notify.id)).toContain(quinn.userId);
    expect((await state()).members.length).toBe(beforeMembers + 1);
    expect(
      await count(
        "SELECT count(*) FROM app.activity WHERE action = 'group.member_added'",
      ),
    ).toBe(memberAdds + 1);
    // One summary row: a fixed summary and counts, no email, name or cell text.
    const rows = (await importRows()).slice(beforeImports);
    expect(rows).toEqual([
      {
        team_id: alpha,
        actor_id: owner.userId,
        actor_type: "session",
        token_id: null,
        record_id: null,
        action: "user-import.applied",
        summary: "Applied a bulk invite workbook",
        metadata: {
          workspaceId: COMPANY,
          group: "normal",
          invited: 2,
          groupAdded: 1,
          alreadyDone: 2,
          needsOwner: 3,
          refused: 18,
        },
      },
    ]);
    expect(Object.keys(rows[0].metadata).sort()).toEqual(
      [
        "workspaceId",
        "group",
        "invited",
        "groupAdded",
        "alreadyDone",
        "needsOwner",
        "refused",
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/@|Fictional/);
    // The second apply sends, adds, mails and records nothing, and reports the parts as done.
    const before = await state();
    const second = await apply(file, owner);
    expect(second.body.data.counts).toEqual({
      invite: 0,
      alreadyDone: 5,
      groupAdd: 0,
      needsOwner: 3,
      refused: 18,
    });
    expect(await state()).toEqual(before);
    // The owner step adds Pat to the three granting groups and refuses Rana's two roles.
    const step = await apply(file, owner, "owner");
    expect(step.body.data.counts).toEqual({
      invite: 0,
      alreadyDone: 5,
      groupAdd: 3,
      needsOwner: 0,
      refused: 18,
    });
    expect(step.body.data.refused).toContainEqual({
      row: 19,
      part: "group",
      reason: conflictSentence("Fictional Rana", "Fictional Alpha"),
    });
    expect(await directMembers(groups.roleTwo.id)).not.toContain(rana.userId);
    for (const group of [groups.roleOne, groups.approvers, groups.nested])
      expect(await directMembers(group.id), group.name).toContain(pat.userId);
    expect((await importRows()).at(-1)?.metadata).toEqual({
      workspaceId: COMPANY,
      group: "owner",
      invited: 0,
      groupAdded: 3,
      alreadyDone: 5,
      needsOwner: 0,
      refused: 18,
    });
    const settled = await state();
    const again = await apply(file, owner, "owner");
    expect(again.body.data.counts).toEqual({
      invite: 0,
      alreadyDone: 8,
      groupAdd: 0,
      needsOwner: 0,
      refused: 18,
    });
    expect(await state()).toEqual(settled);
  });

  it("refuses a two-roles group add when applying, naming the person and the team", async () => {
    // Quinn holds Role One through Role Group once added there; Role Two in the same file conflicts.
    const file = await workbook([
      ["ui-quinn@example.test", null, null, "Fictional Role Group"],
      ["ui-quinn@example.test", null, null, "Fictional Role Two"],
    ]);
    const response = await apply(file, owner, "owner");
    expect(response.body.data.counts).toMatchObject({
      groupAdd: 1,
      refused: 1,
    });
    expect(response.body.data.refused).toEqual([
      {
        row: 3,
        part: "group",
        reason: conflictSentence("Fictional Quinn", "Fictional Alpha"),
      },
    ]);
    expect(await directMembers(groups.roleOne.id)).toContain(quinn.userId);
    expect(await directMembers(groups.roleTwo.id)).not.toContain(quinn.userId);
  });

  it("ignores role and authority columns, flags formula-like cells and reads them as plain text", async () => {
    // The required columns in another order, their headers in other case and spacing, between
    // configured-role, authority, area and plan columns.
    const reordered = await workbook(
      [
        [
          "ui-quinn@example.test",
          "Fictional Configured Cell",
          "Fictional Level Cell",
          "Fictional Alpha",
          "Fictional Area Cell",
          "+recruiter",
          "=Fictional Group",
          "Fictional Plan Cell",
        ],
        [
          "ui-pat@example.test",
          "Fictional Configured Cell",
          "owner",
          "Fictional Alpha",
          "people",
          "Viewer",
          null,
          "yes",
        ],
      ],
      [
        "Email",
        "Configured role",
        "Company level",
        " team ",
        "Areas",
        "TEAM ROLE",
        "Group",
        "Plan access",
      ],
    );
    const checked = await dryRun(reordered, owner);
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({
      counts: { invite: 0, alreadyDone: 1, groupAdd: 0, refused: 2 },
      flagged: [
        { row: 2, column: "Team role" },
        { row: 2, column: "Group" },
      ],
      ignored: ["Configured role", "Company level", "Areas", "Plan access"],
      refused: [
        {
          row: 2,
          part: "invitation",
          reason:
            'You cannot give the team role "+recruiter" in Fictional Alpha; choose Owner, Admin, Recruiter or Viewer.',
        },
        {
          row: 2,
          part: "group",
          reason: 'No group of the company is named "=Fictional Group".',
        },
      ],
    });
    expect(JSON.stringify(checked.body)).not.toMatch(
      /Configured Cell|Level Cell|Area Cell|Plan Cell/,
    );
    const before = await state();
    const applied = await apply(reordered, owner);
    expect(applied.status).toBe(200);
    expect(applied.body.data.counts).toMatchObject({ invite: 0, groupAdd: 0 });
    // No configured role, company authority or team membership changed, and nothing was recorded.
    expect(await state()).toEqual(before);
  });

  it("shows the import row only to company authority, and changes nothing of the second company", async () => {
    const search = new URLSearchParams({ search: "user-import" });
    await harness.dataDb();
    expect(
      (await listActivity(owner, search)).data.some(
        (row) => row.kind === "user-import",
      ),
    ).toBe(true);
    await harness.dataDb();
    expect(
      (await listActivity(pat, search)).data.filter(
        (row) => row.kind === "user-import",
      ),
    ).toEqual([]);
    // Nothing reached the second company's team or group.
    expect(await invited("ui-elsewhere")).toEqual([]);
    expect(await directMembers(groups.elsewhere.id)).toEqual([ownerX.userId]);
  });
});
