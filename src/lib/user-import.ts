import { isAPIError } from "@better-auth/core/utils/is-api-error";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import readXlsx from "read-excel-file/node";
import { z } from "zod";
import { getIdentityDb } from "@/db";
import { invitation, member, user } from "@/db/auth-schema";
import { activity } from "@/db/schema";
import { withPeopleArea } from "@/lib/admin-users";
import type { AppAuth } from "@/lib/auth";
import { rolesFor, type TeamRole } from "@/lib/auth-policy";
import { cleanClientName } from "@/lib/client-name";
import { ApiError } from "@/lib/errors";
import {
  addGroupMember,
  ownerRequired as groupOwnerRequired,
  roleConflictMessage,
} from "@/lib/groups";
import {
  AUDIT_SCOPES,
  checkWorkbookArchive,
  columnLetter,
  FORMULA_LIKE,
  LIST_LIMIT,
  MAX_ROWS,
  unreadable,
  workbookHash,
  type ImportGroup,
} from "@/lib/org-import";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

// Bulk invite and group add from a workbook (ADM-15, IAM-004, architecture 14.3): one .xlsx sheet of
// Email, Team, Team role and Group, checked and parsed with the organisation import's caps, planned
// against the workspace as it is, dry-run without writing, then applied one part at a time through
// Better Auth's invite-member endpoint and addGroupMember, so every existing guard still decides.

/** The columns row 1 must name, in the order a row holds their cells. */
export const USER_IMPORT_COLUMNS = ["Email", "Team", "Team role", "Group"];
export type UserImportPart = "row" | "invitation" | "group";
export type UserImportIssue = {
  row: number;
  part: UserImportPart;
  reason: string;
};
export type UserImportFlag = { row: number; column: string };
export type UserImportCounts = {
  invite: number;
  alreadyDone: number;
  groupAdd: number;
  needsOwner: number;
  refused: number;
};
export type UserImportReport = {
  sha256: string;
  counts: UserImportCounts;
  refused: UserImportIssue[];
  needsOwner: UserImportIssue[];
  flagged: UserImportFlag[];
  /** Every other non-blank header; the cells below it are never read. */
  ignored: string[];
  truncated: boolean;
};
export type UserImportResult = UserImportReport & { group: ImportGroup };

/** A date or boolean cell, which refuses its part. */
const NOT_TEXT = Symbol("not text");
type Cell = string | number | boolean | Date | null;
type CellText = string | null | typeof NOT_TEXT;
type BookRow = {
  row: number;
  email: CellText;
  team: CellText;
  teamRole: CellText;
  group: CellText;
};
export type UserWorkbook = {
  sha256: string;
  rows: BookRow[];
  flagged: UserImportFlag[];
  ignored: string[];
};

const userImportForbidden = () =>
  new ApiError(
    403,
    "user_import_forbidden",
    "Applying a bulk invite needs a current team role that can change candidates, recruitment, CVs or imports, so the import can be recorded in the activity log. Switch to such a team, or ask a company owner to apply it.",
  );
const NO_INVITE_TEAM =
  "You can invite people only to teams where you are an owner or admin.";
const TEAM_ROLES: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  viewer: "Viewer",
};
const email = z.email().max(320);
/** Text from the workbook as a reason shows it: visible characters, at most 120. */
const echo = (value: string) =>
  [...cleanClientName(value)].slice(0, 120).join("");
const listed = (items: string[], last = "and") =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`
    : items[0];

/** A cell as trimmed text, numbers as their decimal string; null when blank. */
function text(cell: Cell): CellText {
  if (cell === null) return null;
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "string") return cell.trim() || null;
  return NOT_TEXT;
}

/**
 * Checks the archive, then reads the first sheet with read-excel-file (values only, never a
 * formula): the header row, the row limit and the data rows, each formula-like cell flagged. Nothing
 * here touches the database.
 */
export async function parseUserWorkbook(bytes: Buffer): Promise<UserWorkbook> {
  checkWorkbookArchive(bytes);
  let sheets: { sheet: string; data: Cell[][] }[];
  try {
    sheets = (await readXlsx(bytes, {
      trim: false,
    })) as unknown as typeof sheets;
  } catch {
    throw unreadable();
  }
  const data = sheets[0]?.data ?? [];
  const count = Math.max(0, data.length - 1);
  if (count > MAX_ROWS)
    throw new ApiError(
      422,
      "import_too_many_rows",
      `The workbook has ${count.toLocaleString("en")} rows below its headers; at most ${MAX_ROWS.toLocaleString("en")} can be imported at once. Split the workbook and import each part.`,
    );
  const header = (data[0] ?? []).map((cell) =>
    typeof cell === "string" ? cell.trim().toLowerCase() : "",
  );
  const columns = USER_IMPORT_COLUMNS.map((column) =>
    header.indexOf(column.toLowerCase()),
  );
  const missing = USER_IMPORT_COLUMNS.filter((_, i) => columns[i] < 0);
  if (missing.length)
    throw new ApiError(
      422,
      "import_columns_missing",
      `Row 1 of the first sheet names the columns Email, Team, Team role and Group, and it has no ${listed(missing)} column.`,
    );
  // Every other non-blank header, by its text, or by its column letter when it is not text.
  const ignored: string[] = [];
  (data[0] ?? []).forEach((cell, i) => {
    const clean = typeof cell === "string" ? cleanClientName(cell) : null;
    if (columns.includes(i) || cell === null || clean === "") return;
    ignored.push(
      clean === null ? `Column ${columnLetter(i)}` : echo(clean as string),
    );
  });
  const flagged: UserImportFlag[] = [];
  const rows: BookRow[] = [];
  data.slice(1).forEach((cells, index) => {
    const values = columns.map((i) => cells[i] ?? null);
    if (
      values.every(
        (cell) => cell === null || (typeof cell === "string" && !cell.trim()),
      )
    )
      return;
    const row = index + 2;
    values.forEach((cell, i) => {
      if (
        (typeof cell === "string" || typeof cell === "number") &&
        FORMULA_LIKE.test(String(cell))
      )
        flagged.push({ row, column: USER_IMPORT_COLUMNS[i] });
    });
    const [address, team, teamRole, group] = values.map(text);
    rows.push({ row, email: address, team, teamRole, group });
  });
  if (!rows.length)
    throw new ApiError(
      422,
      "import_empty",
      "The workbook has no rows to import. Add rows below the headers of the first sheet.",
    );
  return { sha256: workbookHash(bytes), rows, flagged, ignored };
}

type Team = { id: string; name: string; archived: boolean };
type Group = { id: string; name: string; archived: boolean; grants: boolean };
type State = {
  /** The caller's own team role per team id. */
  callerRoles: Map<string, string>;
  teams: Team[];
  groups: Group[];
  /** Per group id, the groups it is directly in. */
  parents: Map<string, string[]>;
  /** Per group id, the roles it gives, by team id. */
  roles: Map<string, { teamId: string; roleObjectId: string }[]>;
  /** Accounts by lower-cased email. */
  accounts: Map<string, { id: string; name: string }>;
  /** Per user id in a team of the workspace: per team id, whether a team owner and whether a role is chosen there. */
  people: Map<string, Map<string, { owner: boolean; chosen: boolean }>>;
  /** groupId:userId of every direct person member. */
  direct: Set<string>;
  /** Per user id, the groups they are effectively in. */
  effective: Map<string, Set<string>>;
  /** teamId:email of each member, and each pending unexpired invitation, of the caller's teams in the file. */
  done: Set<string>;
};

/** The sheet's emails, lower-cased, of the rows whose email is valid. */
const validEmail = (cell: CellText) =>
  typeof cell === "string" && email.safeParse(cell.toLowerCase()).success
    ? cell.toLowerCase()
    : null;
const nameKey = (value: string) => value.toLowerCase();

/**
 * The caller checks: a company owner for the owner step (the groups wording), and for apply a scope
 * the activity insert policy accepts (user_import_forbidden). withPeopleArea has already admitted a
 * session of a company owner or of a company admin with the people area.
 */
function requireCaller(access: TenantAccess, step: "dry-run" | ImportGroup) {
  if (step === "owner" && access.companyLevel !== "owner")
    throw groupOwnerRequired();
  if (
    step !== "dry-run" &&
    !access.scopes.some((scope) => AUDIT_SCOPES.includes(scope))
  )
    throw userImportForbidden();
}

/** Before the body is read: the caller checks in a transaction that reads no row. */
export async function requireUserImportCaller(
  p: Principal,
  step: "dry-run" | ImportGroup,
) {
  await withPeopleArea(p, async (_tx, access) => requireCaller(access, step));
}

/**
 * What the plan needs: the caller's own team roles and the accounts by email from the identity
 * database, then in one read-only withPeopleArea transaction the workspace's teams and groups, how
 * groups nest and the roles they give, and for those accounts their teams in the workspace and
 * groups, then the members and pending invitations of only the caller's owner and admin teams the
 * sheet names.
 */
async function readState(
  p: Principal,
  book: UserWorkbook,
  step: "dry-run" | ImportGroup,
): Promise<State> {
  const identity = await getIdentityDb();
  const callerRoles = new Map(
    (
      await identity
        .select({ teamId: member.organizationId, role: member.role })
        .from(member)
        .where(eq(member.userId, p.userId))
    ).map((row) => [row.teamId, row.role]),
  );
  const groupEmails = [
    ...new Set(
      book.rows.flatMap((row) => {
        const address = validEmail(row.email);
        return address && row.group !== null ? [address] : [];
      }),
    ),
  ];
  const accounts = new Map(
    (groupEmails.length
      ? await identity
          .select({ id: user.id, name: user.name, email: user.email })
          .from(user)
          .where(inArray(sql`lower(${user.email})`, groupEmails))
      : []
    ).map((row) => [row.email.toLowerCase(), { id: row.id, name: row.name }]),
  );
  const ids = JSON.stringify([...accounts.values()].map((row) => row.id));
  const data = await withPeopleArea(p, async (tx, access) => {
    await tx.execute(
      sql`select set_config('transaction_read_only', 'on', true)`,
    );
    requireCaller(access, step);
    const workspace = sql`${access.workspaceId}::uuid`;
    const people = sql`(select jsonb_array_elements_text(${ids}::jsonb))`;
    const { rows } = await tx.execute<{
      teams: Team[];
      groups: Group[];
      nesting: { groupId: string; childId: string }[];
      grants: { groupId: string; teamId: string; roleObjectId: string }[];
      direct: { groupId: string; userId: string }[];
      effective: { groupId: string; userId: string }[];
      people: {
        userId: string;
        teamId: string;
        owner: boolean;
        chosen: boolean;
      }[];
    }>(
      sql`select
        coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'archived', t.archived)) from tenant_context.workspace_team_list() t), '[]'::jsonb) as teams,
        coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'archived', g.archived_at is not null, 'grants', tenant_context.group_grants(g.id))) from app.groups g where g.workspace_id = ${workspace}), '[]'::jsonb) as groups,
        coalesce((select jsonb_agg(jsonb_build_object('groupId', m.group_id, 'childId', m.child_group_id)) from app.group_members m where m.workspace_id = ${workspace} and m.child_group_id is not null), '[]'::jsonb) as nesting,
        coalesce((select jsonb_agg(jsonb_build_object('groupId', r.group_id, 'teamId', r.team_id, 'roleObjectId', r.role_object_id)) from app.group_roles r where r.workspace_id = ${workspace}), '[]'::jsonb) as grants,
        coalesce((select jsonb_agg(jsonb_build_object('groupId', m.group_id, 'userId', m.user_id)) from app.group_members m where m.workspace_id = ${workspace} and m.user_id in ${people}), '[]'::jsonb) as direct,
        coalesce((select jsonb_agg(jsonb_build_object('groupId', e.group_id, 'userId', e.user_id)) from app.group_effective_members e where e.workspace_id = ${workspace} and e.user_id in ${people}), '[]'::jsonb) as effective,
        coalesce((select jsonb_agg(jsonb_build_object('userId', w.user_id, 'teamId', t.id, 'owner', x->>'teamRole' = 'owner',
            'chosen', x->>'configuredRole' is not null and x->>'roleGroup' is null and x->>'roleConflict' = 'false'))
          from jsonb_array_elements_text(${ids}::jsonb) u(id) cross join lateral tenant_context.workspace_person(u.id) w
          cross join lateral jsonb_array_elements(w.teams) x join tenant_context.workspace_team_list() t on t.slug = x->>'slug'), '[]'::jsonb) as people`,
    );
    return rows[0];
  });
  // Only the caller's owner and admin teams the sheet names are looked up.
  const named = new Set(
    book.rows.flatMap((row) =>
      typeof row.team === "string" ? [nameKey(row.team)] : [],
    ),
  );
  const teamIds = data.teams
    .filter(
      (team) =>
        named.has(nameKey(team.name)) &&
        ["owner", "admin"].includes(callerRoles.get(team.id) ?? ""),
    )
    .map((team) => team.id);
  const emails = [
    ...new Set(book.rows.flatMap((row) => validEmail(row.email) ?? [])),
  ];
  const done = new Set<string>();
  if (teamIds.length && emails.length) {
    const db = await getIdentityDb();
    for (const row of await db
      .select({ teamId: member.organizationId, email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          inArray(member.organizationId, teamIds),
          inArray(sql`lower(${user.email})`, emails),
        ),
      ))
      done.add(`${row.teamId}:${row.email.toLowerCase()}`);
    for (const row of await db
      .select({ teamId: invitation.organizationId, email: invitation.email })
      .from(invitation)
      .where(
        and(
          inArray(invitation.organizationId, teamIds),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
          inArray(sql`lower(${invitation.email})`, emails),
        ),
      ))
      done.add(`${row.teamId}:${row.email.toLowerCase()}`);
  }
  const parents = new Map<string, string[]>();
  for (const link of data.nesting)
    parents.set(link.childId, [
      ...(parents.get(link.childId) ?? []),
      link.groupId,
    ]);
  const roles = new Map<string, { teamId: string; roleObjectId: string }[]>();
  for (const grant of data.grants)
    roles.set(grant.groupId, [...(roles.get(grant.groupId) ?? []), grant]);
  const people = new Map<
    string,
    Map<string, { owner: boolean; chosen: boolean }>
  >();
  for (const row of data.people)
    people.set(
      row.userId,
      (people.get(row.userId) ?? new Map()).set(row.teamId, {
        owner: row.owner,
        chosen: row.chosen,
      }),
    );
  const effective = new Map<string, Set<string>>();
  for (const row of data.effective)
    effective.set(
      row.userId,
      (effective.get(row.userId) ?? new Set()).add(row.groupId),
    );
  return {
    callerRoles,
    teams: data.teams,
    groups: data.groups,
    parents,
    roles,
    accounts,
    people,
    direct: new Set(data.direct.map((row) => `${row.groupId}:${row.userId}`)),
    effective,
    done,
  };
}

type Invite = {
  row: number;
  email: string;
  teamId: string;
  role: TeamRole;
};
type GroupAdd = { row: number; groupId: string; userId: string };
type Plan = {
  counts: UserImportCounts;
  refused: UserImportIssue[];
  needsOwner: (UserImportIssue & { add: GroupAdd })[];
  invites: Invite[];
  adds: GroupAdd[];
};

/** A group and every group it is nested in, at any depth. */
function withAncestors(state: State, groupId: string) {
  const found = new Set([groupId]);
  for (const id of found)
    for (const parent of state.parents.get(id) ?? []) found.add(parent);
  return found;
}

/**
 * Classifies each row's invitation part and group part on their own, in row order, against the
 * state: a sent, added or owner-left group part counts for the two-roles check of later rows. Each
 * part gets exactly one outcome, and a row refused as a whole counts once.
 */
export function planUserImport(book: UserWorkbook, state: State): Plan {
  const plan: Plan = {
    counts: {
      invite: 0,
      alreadyDone: 0,
      groupAdd: 0,
      needsOwner: 0,
      refused: 0,
    },
    refused: [],
    needsOwner: [],
    invites: [],
    adds: [],
  };
  const refuse = (row: number, part: UserImportPart, reason: string) => {
    plan.counts.refused++;
    plan.refused.push({ row, part, reason });
  };
  const teamsByName = new Map<string, Team[]>();
  for (const team of state.teams)
    teamsByName.set(nameKey(team.name), [
      ...(teamsByName.get(nameKey(team.name)) ?? []),
      team,
    ]);
  const teamNames = new Map(state.teams.map((team) => [team.id, team.name]));
  const computed = new Set(
    [
      "Company owners",
      "Company admins",
      "All members",
      ...state.teams.flatMap((team) => [
        `Owners of ${team.name}`,
        `Admins of ${team.name}`,
      ]),
    ].map(nameKey),
  );
  const groupsByName = new Map<string, Group[]>();
  for (const group of state.groups)
    groupsByName.set(nameKey(group.name), [
      ...(groupsByName.get(nameKey(group.name)) ?? []),
      group,
    ]);
  const archived = new Set(
    state.groups.filter((group) => group.archived).map((group) => group.id),
  );
  // The first row of each email and team, and of each email and group.
  const seen = {
    team: new Map<string, number>(),
    group: new Map<string, number>(),
  };
  // The groups each person is in once the earlier group parts are applied.
  const effective = new Map(
    [...state.effective].map(([userId, groups]) => [userId, new Set(groups)]),
  );

  for (const row of book.rows) {
    const address = validEmail(row.email);
    if (address === null) {
      refuse(
        row.row,
        "row",
        row.email === null
          ? "Email is blank."
          : row.email === NOT_TEXT
            ? "Email must be text."
            : `"${echo(row.email)}" is not a valid email address.`,
      );
      continue;
    }
    if (row.team === null && row.teamRole === null && row.group === null) {
      refuse(row.row, "row", "Team, Team role and Group are all blank.");
      continue;
    }
    const shown = echo(address);

    // The invitation part.
    if (row.team !== null || row.teamRole !== null) {
      const reason = invitationRefusal(row, state, teamsByName);
      if (typeof reason === "string") refuse(row.row, "invitation", reason);
      else {
        const key = `${reason.team.id}:${address}`;
        const earlier = seen.team.get(key);
        if (earlier !== undefined)
          refuse(
            row.row,
            "invitation",
            `Duplicate of row ${earlier}: the same email and team.`,
          );
        else {
          seen.team.set(key, row.row);
          if (state.done.has(key)) plan.counts.alreadyDone++;
          else {
            plan.counts.invite++;
            plan.invites.push({
              row: row.row,
              email: address,
              teamId: reason.team.id,
              role: reason.role,
            });
          }
        }
      }
    }

    // The group part.
    if (row.group === null) continue;
    if (row.group === NOT_TEXT) {
      refuse(row.row, "group", "Group must be text.");
      continue;
    }
    const groupName = echo(row.group);
    const matches = groupsByName.get(nameKey(row.group)) ?? [];
    if (!matches.length && !computed.has(nameKey(row.group))) {
      refuse(
        row.row,
        "group",
        `No group of the company is named "${groupName}".`,
      );
      continue;
    }
    if (computed.has(nameKey(row.group))) {
      refuse(
        row.row,
        "group",
        `"${groupName}" is a computed group: it is read-only, so you cannot add people to it.`,
      );
      continue;
    }
    const group = matches.find((item) => !item.archived);
    if (!group) {
      refuse(row.row, "group", `The group "${groupName}" is archived.`);
      continue;
    }
    const key = `${group.id}:${address}`;
    const earlier = seen.group.get(key);
    if (earlier !== undefined) {
      refuse(
        row.row,
        "group",
        `Duplicate of row ${earlier}: the same email and group.`,
      );
      continue;
    }
    seen.group.set(key, row.row);
    const account = state.accounts.get(address);
    const teams = account && state.people.get(account.id);
    if (!account || !teams) {
      refuse(
        row.row,
        "group",
        `${shown} is not in a team of the company yet. Apply the same file again after they accept their invitation.`,
      );
      continue;
    }
    // D30, as app.refuse_group_role_conflicts judges it: in a team where a current group being
    // joined gives a role, a member who is not a team owner and has no role chosen there would be
    // in current groups giving two different roles.
    const joined = withAncestors(state, group.id);
    const after = new Set([...(effective.get(account.id) ?? []), ...joined]);
    const rolesIn = (groups: Set<string>, teamId: string) =>
      new Set(
        [...groups].flatMap((id) =>
          archived.has(id)
            ? []
            : (state.roles.get(id) ?? []).flatMap((grant) =>
                grant.teamId === teamId ? [grant.roleObjectId] : [],
              ),
        ),
      );
    const conflict = [...teams]
      .filter(
        ([teamId, place]) =>
          !place.owner &&
          !place.chosen &&
          rolesIn(joined, teamId).size > 0 &&
          rolesIn(after, teamId).size > 1,
      )
      .map(([teamId]) => teamId)
      .sort()[0];
    if (conflict !== undefined) {
      refuse(
        row.row,
        "group",
        roleConflictMessage(
          account.name,
          teamNames.get(conflict) ?? "this team",
        ),
      );
      continue;
    }
    if (state.direct.has(`${group.id}:${account.id}`)) {
      plan.counts.alreadyDone++;
      continue;
    }
    effective.set(account.id, after);
    const add = { row: row.row, groupId: group.id, userId: account.id };
    if (group.grants) {
      plan.counts.needsOwner++;
      plan.needsOwner.push({
        row: row.row,
        part: "group",
        reason: `Adds ${shown} to "${groupName}", which gives a role or approvals, itself or through a group it is in.`,
        add,
      });
    } else {
      plan.counts.groupAdd++;
      plan.adds.push(add);
    }
  }
  return plan;
}

/**
 * The invitation part's refusal, in order: a Team without a Team role or the reverse, an unknown,
 * shared or archived team, a team where the caller is not owner or admin (company authority never
 * counts, D1), and a team role the caller may not give there; else the team and role.
 */
function invitationRefusal(
  row: BookRow,
  state: State,
  teamsByName: Map<string, Team[]>,
): string | { team: Team; role: TeamRole } {
  if (row.team === NOT_TEXT) return "Team must be text.";
  if (row.teamRole === NOT_TEXT) return "Team role must be text.";
  if (row.teamRole === null)
    return "Team role is blank: give the team role to invite them with.";
  if (row.team === null)
    return "Team is blank: name the team to invite them to.";
  const name = echo(row.team);
  const matches = teamsByName.get(nameKey(row.team)) ?? [];
  if (!matches.length) return `No team of the company is named "${name}".`;
  if (matches.length > 1)
    return `The name "${name}" is used by more than one team, so the team cannot be told apart.`;
  const [team] = matches;
  if (team.archived) return `The team "${name}" is archived.`;
  const callerRole = state.callerRoles.get(team.id) ?? null;
  if (callerRole !== "owner" && callerRole !== "admin") return NO_INVITE_TEAM;
  const offered = rolesFor(callerRole);
  const role = offered.find((item) => item === nameKey(row.teamRole as string));
  if (!role)
    return `You cannot give the team role "${echo(row.teamRole)}" in ${name}; choose ${listed(
      offered.map((item) => TEAM_ROLES[item]),
      "or",
    )}.`;
  return { team, role };
}

function report(book: UserWorkbook, plan: Plan): UserImportReport {
  const byRow = (a: UserImportIssue, b: UserImportIssue) => a.row - b.row;
  const refused = [...plan.refused].sort(byRow);
  const needsOwner = plan.needsOwner
    .map(({ row, part, reason }) => ({ row, part, reason }))
    .sort(byRow);
  return {
    sha256: book.sha256,
    counts: plan.counts,
    refused: refused.slice(0, LIST_LIMIT),
    needsOwner: needsOwner.slice(0, LIST_LIMIT),
    flagged: book.flagged.slice(0, LIST_LIMIT),
    ignored: book.ignored.slice(0, LIST_LIMIT),
    truncated: [refused, needsOwner, book.flagged, book.ignored].some(
      (list) => list.length > LIST_LIMIT,
    ),
  };
}

/** The dry run: reads only, in one read-only transaction plus identity reads; it writes nothing. */
export async function dryRunUserImport(
  p: Principal,
  book: UserWorkbook,
): Promise<UserImportReport> {
  return report(
    book,
    planUserImport(book, await readState(p, book, "dry-run")),
  );
}

/** Better Auth's refusals that mean the invitation is already in place. */
const ALREADY = new Set([
  "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
  "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
]);

/**
 * Re-plans against the data as it is now. The normal step sends each invitation, one at a time in
 * row order, through Better Auth's invite-member endpoint with the caller's request headers (its
 * hooks, role checks, owner-only rule and invitation mail run unchanged), then makes each group add
 * that grants nothing with addGroupMember. The owner step makes only the group adds that need a
 * company owner and sends nothing. A refusal becomes that part's reason and the next part runs; any
 * other failure stops with 500. One activity row with counts only records a step that sent or added.
 */
export async function applyUserImport(
  p: Principal,
  book: UserWorkbook,
  group: ImportGroup,
  auth: Pick<AppAuth, "api">,
  headers: Headers,
): Promise<UserImportResult> {
  const plan = planUserImport(book, await readState(p, book, group));
  const counts: UserImportCounts = {
    invite: 0,
    alreadyDone: plan.counts.alreadyDone,
    groupAdd: 0,
    needsOwner: group === "owner" ? 0 : plan.counts.needsOwner,
    refused: plan.counts.refused,
  };
  const refuse = (row: number, part: UserImportPart, reason: string) => {
    counts.refused++;
    plan.refused.push({ row, part, reason });
  };
  try {
    if (group === "normal")
      for (const invite of plan.invites)
        try {
          await auth.api.createInvitation({
            headers,
            body: {
              email: invite.email,
              role: invite.role,
              organizationId: invite.teamId,
            },
          });
          counts.invite++;
        } catch (error) {
          if (!isAPIError(error)) throw error;
          if (ALREADY.has(String(error.body?.code))) counts.alreadyDone++;
          else
            refuse(
              invite.row,
              "invitation",
              error.body?.message || error.message,
            );
        }
    for (const add of group === "owner"
      ? plan.needsOwner.map((entry) => entry.add)
      : plan.adds)
      try {
        await addGroupMember(p, add.groupId, { userId: add.userId });
        counts.groupAdd++;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.code === "group_member_exists") counts.alreadyDone++;
        else refuse(add.row, "group", error.message);
      }
  } catch (error) {
    throw stopped(error);
  }
  if (counts.invite + counts.groupAdd > 0)
    await withPeopleArea(p, async (tx, access) => {
      requireCaller(access, group);
      await tx.insert(activity).values({
        teamId: p.teamId,
        recordId: null,
        actorId: p.userId,
        actorType: "session",
        tokenId: null,
        action: "user-import.applied",
        kind: "user-import",
        summary: "Applied a bulk invite workbook",
        metadata: {
          workspaceId: access.workspaceId,
          group,
          invited: counts.invite,
          groupAdded: counts.groupAdd,
          alreadyDone: counts.alreadyDone,
          needsOwner: counts.needsOwner,
          refused: counts.refused,
        },
      });
    });
  return {
    ...report(book, {
      ...plan,
      counts,
      needsOwner: group === "owner" ? [] : plan.needsOwner,
    }),
    group,
  };
}

/** A failure that is not a part's refusal; what was sent or added stays, so a retry is safe. */
function stopped(error: unknown) {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  console.error(
    `user_import_incomplete category=${(error as { constructor?: { name?: string } } | null)?.constructor?.name || typeof error}${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` sqlstate=${code}` : ""}`,
  );
  return new ApiError(
    500,
    "internal_error",
    "The bulk invite could not finish. Applying the same file again is safe: invitations already sent and people already added are reported as already done.",
  );
}
