import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { sql, type SQL } from "drizzle-orm";
import readXlsx from "read-excel-file/node";
import type { TeamTx } from "@/db";
import { activity } from "@/db/schema";
import { configLabel, type JobArchitectureBody } from "@/domain/config";
import { employeeInput } from "@/domain/directory";
import { XLSX_TYPE } from "@/domain/org";
import { ApiError, readLimitedBytes } from "@/lib/api";
import { cleanClientName } from "@/lib/client-name";
import {
  inDirectory,
  leftAt,
  ownerRequired as directoryOwnerRequired,
  requireDirectory,
  stateConflict,
} from "@/lib/directory";
import { jobArchitectureFor } from "@/lib/job-architecture";
import { inOrg, requireWrite } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

// Excel import for the organisation (R2a-17, architecture 6.4): one .xlsx workbook with Units,
// Positions and Employees sheets, checked before parsing, planned against the workspace's current
// rows, dry-run in a read-only transaction and applied one sheet per transaction through the same
// columns, checks and database guards as the org and directory services. Cell values are text facts.

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20_000;
const MAX_ENTRIES = 2_000;
const MAX_EXPANDED = 50 * 1024 * 1024;
/** Each list in a response; the counts are always complete. */
export const LIST_LIMIT = 500;
/** Rows per write statement. */
const CHUNK = 1_000;
const DATA_DESCRIPTOR = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
/** The activity insert policy (tenant_context.allows_event) needs one of these in the context. */
export const AUDIT_SCOPES = [
  "candidates:write",
  "recruitment:write",
  "cvs:write",
  "imports:write",
];

/** The sheets in the order apply writes them, with their columns. */
export const IMPORT_SHEETS = ["Units", "Positions", "Employees"] as const;
export type ImportSheet = (typeof IMPORT_SHEETS)[number];
const COLUMNS = {
  Units: ["Code", "Name", "Level", "Parent code"],
  Positions: ["Code", "Title", "Unit code", "Manager"],
  Employees: [
    "Employee number",
    "Name",
    "Work email",
    "Work phone",
    "Position codes",
    "Primary position",
  ],
} as const satisfies Record<ImportSheet, readonly string[]>;
/** Columns a sheet may have; each row's cells hold them after the required ones. */
const OPTIONAL = {
  Units: [],
  Positions: ["Job title", "Grade"],
  Employees: [],
} as const satisfies Record<ImportSheet, readonly string[]>;
const sheetColumns = (name: ImportSheet): readonly string[] => [
  ...COLUMNS[name],
  ...OPTIONAL[name],
];
export type ImportGroup = "normal" | "owner";

export type ImportIssue = { sheet: ImportSheet; row: number; reason: string };
export type ImportFlag = { sheet: ImportSheet; row: number; column: string };
/** A header the import does not read; the cells below it are never read, stored or returned. */
export type ImportIgnored = { sheet: ImportSheet; column: string };
/** A position row whose Job title matched a published title, with that title's grade. */
export type ImportJobTitle = {
  row: number;
  code: string;
  titleKey: string;
  titleName: string;
  gradeCode: string;
  gradeName: string;
};
export type ImportCounts = {
  create: number;
  update: number;
  unchanged: number;
  reject: number;
  needsOwner: number;
};
export type ImportReport = {
  sha256: string;
  sheets: Record<"units" | "positions" | "employees", ImportCounts>;
  rejected: ImportIssue[];
  needsOwner: ImportIssue[];
  flagged: ImportFlag[];
  jobTitles: ImportJobTitle[];
  ignored: ImportIgnored[];
  truncated: boolean;
};

type UnitRow = {
  row: number;
  code: string;
  name: string;
  level: string;
  parentCode: string | null;
};
type PositionRow = {
  row: number;
  code: string;
  title: string;
  unitCode: string;
  manager: boolean | null;
  jobTitle: string | null;
  grade: string | null;
};
type EmployeeRow = {
  row: number;
  number: string;
  name: string;
  email: string | null;
  phone: string | null;
  codes: string[] | null;
  primary: string | null;
};
/** A row refused by its own cells; key is its code or employee number when that cell was valid. */
type Invalid = { row: number; key: string | null; reason: string };
export type Workbook = {
  sha256: string;
  units: (UnitRow | Invalid)[];
  positions: (PositionRow | Invalid)[];
  employees: (EmployeeRow | Invalid)[];
  flagged: ImportFlag[];
  ignored: ImportIgnored[];
};

const tooLarge = () =>
  new ApiError(
    413,
    "import_too_large",
    "The file is larger than 5 MiB. Split the workbook and import each part.",
  );
export const unreadable = () =>
  new ApiError(
    422,
    "import_unreadable",
    "The file is not a readable .xlsx workbook. Save it from Excel as an .xlsx workbook, without a password, and try again.",
  );
const archiveTooLarge = () =>
  new ApiError(
    422,
    "import_archive_too_large",
    "The workbook holds more than 2,000 files or more than 50 MiB once unpacked. Remove other sheets, images and formatting, or split the workbook.",
  );
const fileChanged = () =>
  new ApiError(
    409,
    "import_file_changed",
    "This file is not the one you checked. Choose the file again and run Check file before applying it.",
  );
const importForbidden = () =>
  new ApiError(
    403,
    "org_import_forbidden",
    "Applying an import needs a role that can change candidates, recruitment, CVs or imports, so the import can be recorded in the activity log. Ask a company owner to apply it.",
  );

/** The raw workbook body: the xlsx content type, at most 5 MiB, read before anything is parsed. */
export async function readWorkbookBytes(request: Request): Promise<Buffer> {
  const type = request.headers.get("content-type")?.split(";")[0];
  if (type?.trim().toLowerCase() !== XLSX_TYPE)
    throw new ApiError(
      415,
      "xlsx_required",
      `Send the workbook as ${XLSX_TYPE}.`,
    );
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimitedBytes(request, IMPORT_MAX_BYTES);
  } catch (error) {
    if (error instanceof ApiError && error.code === "body_too_large")
      throw tooLarge();
    throw error;
  }
  if (!bytes) throw unreadable();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export const workbookHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The apply query: the dry run's SHA-256 and an optional group=owner, nothing else. */
export function applyQuery(params: URLSearchParams): {
  sha256: string;
  group: ImportGroup;
} {
  const sha256 = params.get("sha256")?.toLowerCase() ?? "";
  const group = params.get("group");
  if (
    [...params.keys()].some((key) => key !== "sha256" && key !== "group") ||
    params.getAll("sha256").length !== 1 ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    params.getAll("group").length > 1 ||
    (group !== null && group !== "owner")
  )
    throw new ApiError(
      400,
      "invalid_input",
      "Send sha256, the 64-character SHA-256 the dry run returned, and optionally group=owner.",
    );
  return { sha256, group: group === "owner" ? "owner" : "normal" };
}

/** A different file than the dry run's is refused before it is parsed. */
export function requireSameFile(bytes: Uint8Array, sha256: string) {
  if (workbookHash(bytes) !== sha256) throw fileChanged();
}

/**
 * Reads the zip central directory before any parser expands the workbook (following
 * validateWorkbookZip in scripts/legacy/files.ts): a missing or invalid directory, ZIP64, several
 * disks or encryption are unreadable; more than 2,000 entries or 50 MiB declared uncompressed are
 * too large; an empty, absolute, backslash, NUL, drive-letter or `..` entry name is unreadable.
 * read-excel-file streams the local headers instead (unzipper), so each local entry must then
 * match its directory entry and inflate to exactly its declared size; anything else is unreadable.
 */
export function checkWorkbookArchive(bytes: Buffer) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw unreadable();
  const entries = bytes.readUInt16LE(eocd + 10),
    size = bytes.readUInt32LE(eocd + 12),
    offset = bytes.readUInt32LE(eocd + 16);
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== entries ||
    entries === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    // The directory ends where the end record starts, and the end record and its comment end the
    // file, so unzipper, which reads on until an end record, meets no record the checks skip.
    offset + size !== eocd ||
    eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length ||
    (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === 0x07064b50)
  )
    throw unreadable();
  const names: string[] = [];
  const records: {
    flags: number;
    method: number;
    compressed: number;
    expanded: number;
    name: Buffer;
    local: number;
  }[] = [];
  let pointer = offset,
    total = 0;
  for (let i = 0; i < entries; i++) {
    if (
      pointer + 46 > offset + size ||
      bytes.readUInt32LE(pointer) !== 0x02014b50
    )
      throw unreadable();
    const compressed = bytes.readUInt32LE(pointer + 20),
      expanded = bytes.readUInt32LE(pointer + 24),
      nameLength = bytes.readUInt16LE(pointer + 28),
      end =
        pointer +
        46 +
        nameLength +
        bytes.readUInt16LE(pointer + 30) +
        bytes.readUInt16LE(pointer + 32);
    // Bit 0 is encryption and bit 6 strong encryption; 0xffffffff sizes or offsets are ZIP64.
    if (
      bytes.readUInt16LE(pointer + 8) & 0x41 ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff ||
      bytes.readUInt32LE(pointer + 42) === 0xffffffff ||
      end > offset + size
    )
      throw unreadable();
    names.push(bytes.toString("utf8", pointer + 46, pointer + 46 + nameLength));
    records.push({
      flags: bytes.readUInt16LE(pointer + 8),
      method: bytes.readUInt16LE(pointer + 10),
      compressed,
      expanded,
      name: bytes.subarray(pointer + 46, pointer + 46 + nameLength),
      local: bytes.readUInt32LE(pointer + 42),
    });
    total += expanded;
    pointer = end;
  }
  if (pointer !== offset + size) throw unreadable();
  if (entries > MAX_ENTRIES || total > MAX_EXPANDED) throw archiveTooLarge();
  if (
    names.some(
      (name) =>
        !name ||
        /^[/\\]/.test(name) ||
        /[\\\0]/.test(name) ||
        /(^|\/)[A-Za-z]:/.test(name) ||
        name.split("/").includes(".."),
    )
  )
    throw unreadable();
  // The local entries, in order from the start of the file to the directory, as unzipper reads
  // them: sizes from the local header, or, for a bit 3 entry without them, the bytes up to the
  // first data descriptor signature and then a 16-byte descriptor.
  let local = 0;
  for (const record of records) {
    if (
      record.local !== local ||
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw unreadable();
    const flags = bytes.readUInt16LE(local + 6),
      method = bytes.readUInt16LE(local + 8),
      compressed = bytes.readUInt32LE(local + 18),
      nameLength = bytes.readUInt16LE(local + 26),
      start = local + 30 + nameLength + bytes.readUInt16LE(local + 28),
      end = start + record.compressed;
    if (
      flags !== record.flags ||
      method !== record.method ||
      (method !== 0 && method !== 8) ||
      !bytes
        .subarray(local + 30, local + 30 + nameLength)
        .equals(record.name) ||
      end > offset
    )
      throw unreadable();
    if (flags & 0x08 && compressed === 0) {
      if (
        bytes.indexOf(DATA_DESCRIPTOR, start) !== end ||
        end + 16 > offset ||
        bytes.readUInt32LE(end + 8) !== record.compressed ||
        bytes.readUInt32LE(end + 12) !== record.expanded
      )
        throw unreadable();
      local = end + 16;
    } else {
      if (
        compressed !== record.compressed ||
        bytes.readUInt32LE(local + 22) !== record.expanded
      )
        throw unreadable();
      local = end;
    }
    // Inflating stops past the declared size, so the whole check stays within the 50 MiB.
    let expanded = end - start;
    if (method === 8)
      try {
        expanded = inflateRawSync(bytes.subarray(start, end), {
          maxOutputLength: Math.max(1, record.expanded),
        }).length;
      } catch {
        throw unreadable();
      }
    if (expanded !== record.expanded) throw unreadable();
  }
  if (local !== offset) throw unreadable();
}

type CellValue = string | number | boolean | Date | null;
/** Thrown inside a row reader; the row is rejected with this reason. */
class RowError extends Error {}
/** The text a formula or CSV injection starts with, as safeCsvCell checks it. */
export const FORMULA_LIKE = /^\s*[=+\-@\t\r]/;
/** A zero-based column index as its spreadsheet letters: A, B, …, Z, AA, … */
export const columnLetter = (index: number): string =>
  (index >= 26 ? columnLetter(Math.floor(index / 26) - 1) : "") +
  String.fromCharCode(65 + (index % 26));

/**
 * Checks the archive, parses the workbook with read-excel-file (values only: a formula's cached
 * value, never the formula) and turns each data row into a typed row or a reason. Nothing here
 * touches the database.
 */
export async function parseWorkbook(bytes: Buffer): Promise<Workbook> {
  checkWorkbookArchive(bytes);
  let sheets: { sheet: string; data: CellValue[][] }[];
  try {
    sheets = (await readXlsx(bytes, {
      trim: false,
    })) as unknown as typeof sheets;
  } catch {
    throw unreadable();
  }
  const found = {} as Record<ImportSheet, CellValue[][]>;
  for (const name of IMPORT_SHEETS) {
    const matches = sheets.filter(
      (sheet) => sheet.sheet.trim().toLowerCase() === name.toLowerCase(),
    );
    if (matches.length > 1)
      throw new ApiError(
        422,
        "import_unreadable",
        `The workbook has more than one ${name} sheet. Keep one and try again.`,
      );
    found[name] = matches[0]?.data ?? [];
  }
  const rows = IMPORT_SHEETS.reduce(
    (sum, name) => sum + Math.max(0, found[name].length - 1),
    0,
  );
  if (rows > MAX_ROWS)
    throw new ApiError(
      422,
      "import_too_many_rows",
      `The workbook has ${rows.toLocaleString("en")} rows below its headers; at most 20,000 can be imported at once. Split the workbook and import each part.`,
    );
  const columns = {} as Record<ImportSheet, number[]>;
  const missing: string[] = [];
  for (const name of IMPORT_SHEETS) {
    if (!found[name].length) continue;
    const header = found[name][0].map((cell) =>
      typeof cell === "string" ? cell.trim().toLowerCase() : "",
    );
    columns[name] = sheetColumns(name).map((column) =>
      header.indexOf(column.toLowerCase()),
    );
    const absent = COLUMNS[name].filter((_, i) => columns[name][i] < 0);
    if (absent.length)
      missing.push(`the ${name} sheet has no ${absent.join(", ")} column`);
  }
  if (missing.length)
    throw new ApiError(
      422,
      "import_columns_missing",
      `Row 1 of each sheet names its columns, and ${missing.join("; ")}.`,
    );
  // Every other non-blank header, by its text, or by its column letter when it is not text; the
  // cells below it are never copied into a row.
  const ignored: ImportIgnored[] = [];
  for (const name of IMPORT_SHEETS) {
    if (!found[name].length) continue;
    found[name][0].forEach((cell, i) => {
      const clean = typeof cell === "string" ? cleanClientName(cell) : null;
      if (columns[name].includes(i) || cell === null || clean === "") return;
      ignored.push({
        sheet: name,
        column:
          clean === null
            ? `Column ${columnLetter(i)}`
            : [...clean].slice(0, 120).join(""),
      });
    });
  }
  const flagged: ImportFlag[] = [];
  /** The non-blank data rows of a sheet as cells by column, with each formula-like cell flagged. */
  const dataRows = (name: ImportSheet) =>
    found[name].slice(1).flatMap((cells, index) => {
      const values = columns[name].map((i) =>
        i < 0 ? null : (cells[i] ?? null),
      );
      if (
        cells.every(
          (cell) => cell === null || (typeof cell === "string" && !cell.trim()),
        )
      )
        return [];
      const row = index + 2;
      values.forEach((cell, i) => {
        if (
          (typeof cell === "string" || typeof cell === "number") &&
          FORMULA_LIKE.test(String(cell))
        )
          flagged.push({ sheet: name, row, column: sheetColumns(name)[i] });
      });
      return [{ row, values }];
    });
  const book: Workbook = {
    sha256: workbookHash(bytes),
    units: dataRows("Units").map(({ row, values }) => unitRow(row, values)),
    positions: dataRows("Positions").map(({ row, values }) =>
      positionRow(row, values),
    ),
    employees: dataRows("Employees").map(({ row, values }) =>
      employeeRow(row, values),
    ),
    flagged,
    ignored,
  };
  if (!book.units.length && !book.positions.length && !book.employees.length)
    throw new ApiError(
      422,
      "import_empty",
      "The workbook has no rows to import. Add rows below the headers of a Units, Positions or Employees sheet.",
    );
  return book;
}

/** A cell as trimmed text, or null when blank; numbers become their decimal string. */
function text(cell: CellValue, subject: string, column: string) {
  if (cell === null) return null;
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "string") return cell.trim() || null;
  throw new RowError(`${subject}: ${column} must be text.`);
}
/** A code, name, title or number under the configuration label rule. */
function label(
  cell: CellValue,
  subject: string,
  column: string,
  required: true,
): string;
function label(
  cell: CellValue,
  subject: string,
  column: string,
  required: false,
): string | null;
function label(
  cell: CellValue,
  subject: string,
  column: string,
  required: boolean,
) {
  const value = text(cell, subject, column);
  if (value === null || !cleanClientName(value)) {
    if (required) throw new RowError(`${subject}: ${column} is required.`);
    return null;
  }
  const parsed = configLabel.safeParse(value);
  if (!parsed.success)
    throw new RowError(`${subject}: ${column} must be at most 120 characters.`);
  return parsed.data;
}
/** Runs a row reader; a refused cell gives the row its reason, keyed by the row's code if valid. */
function readRow<T>(
  row: number,
  read: (key: (value: string) => string) => T,
): T | Invalid {
  let key: string | null = null;
  try {
    return read((value) => {
      key = value;
      return value;
    });
  } catch (error) {
    if (error instanceof RowError) return { row, key, reason: error.message };
    throw error;
  }
}

function unitRow(row: number, cells: CellValue[]) {
  return readRow<UnitRow>(row, (key) => {
    const code = key(label(cells[0], `Row ${row}`, "Code", true));
    const subject = `Unit ${code}`;
    return {
      row,
      code,
      name: label(cells[1], subject, "Name", true),
      level: label(cells[2], subject, "Level", true),
      parentCode: label(cells[3], subject, "Parent code", false),
    };
  });
}

function positionRow(row: number, cells: CellValue[]) {
  return readRow<PositionRow>(row, (key) => {
    const code = key(label(cells[0], `Row ${row}`, "Code", true));
    const subject = `Position ${code}`;
    const title = label(cells[1], subject, "Title", true);
    const unitCode = label(cells[2], subject, "Unit code", true);
    const cell = cells[3];
    let manager: boolean | null = null;
    if (typeof cell === "boolean") manager = cell;
    else if (cell !== null) {
      const value = typeof cell === "string" ? cell.trim().toLowerCase() : "?";
      if (value === "yes" || value === "true") manager = true;
      else if (value === "no" || value === "false") manager = false;
      else if (value)
        throw new RowError(`${subject}: Manager must be yes or no.`);
    }
    const jobTitle = label(cells[4], subject, "Job title", false);
    const grade = label(cells[5], subject, "Grade", false);
    return { row, code, title, unitCode, manager, jobTitle, grade };
  });
}

/** A comma- or semicolon-separated list of codes, each under the label rule; null when blank. */
function codeList(cell: CellValue, subject: string, column: string) {
  const value = text(cell, subject, column);
  if (value === null) return null;
  const codes = value.split(/[,;]/).map(cleanClientName).filter(Boolean);
  if (codes.some((code) => !configLabel.safeParse(code).success))
    throw new RowError(
      `${subject}: each code in ${column} must be at most 120 characters.`,
    );
  return codes.length ? codes : null;
}

function employeeRow(row: number, cells: CellValue[]) {
  return readRow<EmployeeRow>(row, (key) => {
    const number = key(label(cells[0], `Row ${row}`, "Employee number", true));
    const subject = `Employee ${number}`;
    const name = label(cells[1], subject, "Name", true);
    const email = text(cells[2], subject, "Work email");
    const phone = text(cells[3], subject, "Work phone");
    // Today's employeeInput rules; blank cells are left out, so they leave stored values alone.
    const parsed = employeeInput.safeParse({
      displayName: name,
      employeeNumber: number,
      ...(email === null ? {} : { workEmail: email }),
      ...(phone === null ? {} : { workPhone: phone }),
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0].path[0];
      throw new RowError(
        field === "workEmail"
          ? `${subject}: Work email is not a valid email address.`
          : field === "workPhone"
            ? `${subject}: Work phone must be at most 100 characters.`
            : `${subject}: Name and Employee number must be 1 to 120 visible characters.`,
      );
    }
    const codes = codeList(cells[4], subject, "Position codes");
    if (codes && new Set(codes).size !== codes.length)
      throw new RowError(
        `${subject}: Position codes lists ${codes.find((code, i) => codes.indexOf(code) !== i)} more than once.`,
      );
    if (codes && codes.length > 20)
      throw new RowError(`${subject}: more than 20 position codes.`);
    const primaries = codeList(cells[5], subject, "Primary position");
    if (primaries && primaries.length > 1)
      throw new RowError(`${subject}: more than one primary position.`);
    const primary = primaries?.[0] ?? null;
    if (primary !== null && !codes?.includes(primary))
      throw new RowError(
        `${subject}: primary position ${primary} is not one of the position codes.`,
      );
    return {
      row,
      number,
      name: parsed.data.displayName,
      email: parsed.data.workEmail ?? null,
      phone: parsed.data.workPhone ?? null,
      codes,
      primary,
    };
  });
}

type State = {
  levels: { id: string; name: string; depth: number; archived: boolean }[];
  units: {
    id: string;
    code: string;
    name: string;
    levelId: string;
    parentId: string | null;
  }[];
  /** The latest row of each workbook unit code, by valid_from, as app.guard_scope_sources reads it. */
  unitLatest: { code: string; parentId: string | null }[];
  /** held: a current position row of an employee linked to a user. */
  positions: {
    id: string;
    code: string;
    title: string;
    isManager: boolean;
    unitId: string;
    jobTitleKey: string | null;
    held: boolean;
  }[];
  positionLatest: { code: string; unitId: string; held: boolean }[];
  employees: {
    id: string;
    number: string;
    name: string;
    email: string | null;
    phone: string | null;
    linked: boolean;
    archived: boolean;
    positions: { positionId: string; primary: boolean }[];
  }[];
};

const keys = (rows: (object & { row: number })[], key: string) =>
  JSON.stringify(
    rows.flatMap((row) =>
      key in row ? [String((row as Record<string, unknown>)[key])] : [],
    ),
  );

/** The workspace's current rows the workbook can touch, in one statement. */
async function readState(
  tx: TeamTx,
  access: TenantAccess,
  book: Workbook,
): Promise<State> {
  const workspace = sql`${access.workspaceId}::uuid`;
  const held = (id: SQL) =>
    sql`exists (select 1 from app.employee_positions ep join app.employees e on e.id = ep.employee_id and e.workspace_id = ep.workspace_id where ep.workspace_id = ${workspace} and ep.position_id = ${id} and ep.valid_to is null and e.user_id is not null)`;
  const { rows } = await tx.execute<State>(
    sql`select
      coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'depth', l.depth, 'archived', l.archived_at is not null)) from app.org_levels l where l.workspace_id = ${workspace}), '[]'::jsonb) as levels,
      coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'code', u.code, 'name', u.name, 'levelId', u.level_id, 'parentId', u.parent_id)) from app.org_units u where u.workspace_id = ${workspace} and u.valid_to is null and u.archived_at is null), '[]'::jsonb) as units,
      coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'parentId', t.parent_id)) from (select distinct on (u.code) u.code, u.parent_id from app.org_units u where u.workspace_id = ${workspace} and u.code in (select jsonb_array_elements_text(${keys(book.units, "code")}::jsonb)) order by u.code, u.valid_from desc, u.id desc) t), '[]'::jsonb) as "unitLatest",
      coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'title', p.title, 'isManager', p.is_manager, 'unitId', p.org_unit_id, 'jobTitleKey', p.job_title_key, 'held', ${held(sql`p.id`)})) from app.positions p where p.workspace_id = ${workspace} and p.valid_to is null and p.archived_at is null), '[]'::jsonb) as positions,
      coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'unitId', t.org_unit_id, 'held', ${held(sql`t.id`)})) from (select distinct on (p.code) p.id, p.code, p.org_unit_id from app.positions p where p.workspace_id = ${workspace} and p.code in (select jsonb_array_elements_text(${keys(book.positions, "code")}::jsonb)) order by p.code, p.valid_from desc, p.id desc) t), '[]'::jsonb) as "positionLatest",
      coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'number', e.employee_number, 'name', e.display_name, 'email', e.work_email, 'phone', e.work_phone, 'linked', e.user_id is not null, 'archived', e.archived_at is not null,
        'positions', coalesce((select jsonb_agg(jsonb_build_object('positionId', ep.position_id, 'primary', ep."primary")) from app.employee_positions ep where ep.employee_id = e.id and ep.workspace_id = e.workspace_id and ep.valid_to is null), '[]'::jsonb)))
        from app.employees e where e.workspace_id = ${workspace} and e.employee_number in (select jsonb_array_elements_text(${keys(book.employees, "number")}::jsonb))), '[]'::jsonb) as employees`,
  );
  return rows[0];
}

type Status = "create" | "update" | "unchanged" | "owner" | "reject";
/** An existing row by id, or a row this step creates earlier in the same transaction, by code. */
type Ref = { id: string } | { code: string };
type UnitWrite = {
  id: string | null;
  code: string;
  name: string;
  levelId: string;
  depth: number;
  parent: Ref | null;
};
type PositionWrite = {
  id: string | null;
  code: string;
  title: string;
  isManager: boolean | null;
  /** Null when an existing position stays in its unit. */
  unit: Ref | null;
  /** Null leaves an existing position's job title as it is. */
  jobTitleKey: string | null;
};
type EmployeeWrite = {
  id: string | null;
  number: string;
  name: string;
  email: string | null;
  phone: string | null;
  facts: boolean;
  positions: { ref: Ref; primary: boolean }[] | null;
  held: { positionId: string; primary: boolean }[];
};
type SheetPlan<W> = {
  statuses: Map<string, Status>;
  counts: ImportCounts;
  rejected: ImportIssue[];
  needsOwner: ImportIssue[];
  jobTitles: ImportJobTitle[];
  writes: W[];
};
type Plan = {
  Units: SheetPlan<UnitWrite>;
  Positions: SheetPlan<PositionWrite>;
  Employees: SheetPlan<EmployeeWrite>;
};

/** Collects one sheet's outcome; key is the row's code or employee number. */
function sheetPlan<W>(sheet: ImportSheet, group: ImportGroup) {
  const plan: SheetPlan<W> = {
    statuses: new Map(),
    counts: { create: 0, update: 0, unchanged: 0, reject: 0, needsOwner: 0 },
    rejected: [],
    needsOwner: [],
    jobTitles: [],
    writes: [],
  };
  return {
    plan,
    reject(row: number, key: string | null, reason: string) {
      if (key !== null) plan.statuses.set(key, "reject");
      plan.counts.reject++;
      plan.rejected.push({ sheet, row, reason });
    },
    /** A classified row; a written one also carries what to write. */
    settle(
      row: number,
      key: string,
      status: Exclude<Status, "reject">,
      reason: string,
      write: W,
    ) {
      plan.statuses.set(key, status);
      if (status === "owner" && group === "normal") {
        plan.counts.needsOwner++;
        plan.needsOwner.push({ sheet, row, reason });
      } else if (status === "unchanged") plan.counts.unchanged++;
      else if ((group === "owner") === (status === "owner")) {
        const id = (write as { id: string | null }).id;
        plan.counts[id === null ? "create" : "update"]++;
        plan.writes.push(write);
      }
    },
  };
}

const isInvalid = <T extends object>(row: T | Invalid): row is Invalid =>
  "reason" in row;
/** The keys that appear on more than one row with a valid key, invalid rows included. */
function duplicates(rows: { key: string | null }[]) {
  const seen = new Set<string>(),
    twice = new Set<string>();
  for (const { key } of rows)
    if (key !== null) (seen.has(key) ? twice : seen).add(key);
  return twice;
}

/**
 * Classifies every row of the workbook against the current rows. A normal plan writes the create
 * and update rows; an owner plan writes only the rows that need a company owner. A written row
 * whose unit, parent or position is not current and is not created by the same step is rejected.
 */
export function planImport(
  book: Workbook,
  state: State,
  group: ImportGroup,
  architecture: JobArchitectureBody | null,
): Plan {
  const units = planUnits(book, state, group);
  const positions = planPositions(
    book,
    state,
    group,
    units.statuses,
    architecture,
  );
  const employees = planEmployees(book, state, group, positions.statuses);
  return { Units: units, Positions: positions, Employees: employees };
}

/** Whether a row with this status is created by a step of this group. */
const createdBy = (group: ImportGroup, status: Status | undefined) =>
  group === "normal" ? status === "create" : status === "owner";
const waitingReason = (group: ImportGroup, what: string) =>
  group === "normal"
    ? `${what} needs a company owner first`
    : `${what} does not exist yet; apply the import first`;

function planUnits(book: Workbook, state: State, group: ImportGroup) {
  const { plan, reject, settle } = sheetPlan<UnitWrite>("Units", group);
  const current = new Map(state.units.map((unit) => [unit.code, unit]));
  const byId = new Map(state.units.map((unit) => [unit.id, unit]));
  const levelDepth = new Map(state.levels.map((l) => [l.id, l.depth]));
  const latest = new Map(state.unitLatest.map((row) => [row.code, row]));
  const twice = duplicates(
    book.units.map((row) => ({ key: isInvalid(row) ? row.key : row.code })),
  );
  const rows: (UnitRow & { levelId: string; depth: number })[] = [];
  for (const row of book.units) {
    if (isInvalid(row)) reject(row.row, row.key, row.reason);
    else if (twice.has(row.code))
      reject(
        row.row,
        row.code,
        `Unit ${row.code}: duplicate code; it is on more than one row.`,
      );
    else {
      const levels = state.levels.filter(
        (level) =>
          !level.archived &&
          level.name.toLowerCase() === row.level.toLowerCase(),
      );
      if (levels.length === 1)
        rows.push({ ...row, levelId: levels[0].id, depth: levels[0].depth });
      else
        reject(
          row.row,
          row.code,
          levels.length
            ? `Unit ${row.code}: level name matches more than one level.`
            : `Unit ${row.code}: unknown level "${row.level}".`,
        );
    }
  }
  // The parent of every code once the workbook is applied: the sheet's, else the current one.
  const parentOf = new Map<string, string | null>();
  for (const unit of state.units)
    parentOf.set(
      unit.code,
      unit.parentId ? (byId.get(unit.parentId)?.code ?? null) : null,
    );
  for (const row of book.units)
    if (!isInvalid(row)) parentOf.set(row.code, row.parentCode);
  const cyclic = new Set<string>();
  const done = new Set<string>();
  for (const start of rows) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let code: string | null = start.code;
    while (code !== null && !done.has(code) && !onPath.has(code)) {
      path.push(code);
      onPath.add(code);
      code = parentOf.get(code) ?? null;
    }
    if (code !== null && onPath.has(code))
      for (const member of path.slice(path.indexOf(code))) cyclic.add(member);
    for (const member of path) done.add(member);
  }
  const sheetDepth = new Map(rows.map((row) => [row.code, row.depth]));
  // Parents first: a parent's level is above its children's, so it is settled before them.
  for (const row of rows.sort((a, b) => a.depth - b.depth || a.row - b.row)) {
    const subject = `Unit ${row.code}`;
    if (cyclic.has(row.code)) {
      reject(
        row.row,
        row.code,
        `${subject}: cyclic parent; its parent codes lead back to it.`,
      );
      continue;
    }
    let parent: { id: string | null; depth: number } | null = null;
    if (row.parentCode !== null) {
      const existing = current.get(row.parentCode);
      // Every rejected workbook row with a code is settled before this loop or above this level.
      if (plan.statuses.get(row.parentCode) === "reject") {
        reject(
          row.row,
          row.code,
          `${subject}: its parent ${row.parentCode} is rejected.`,
        );
        continue;
      }
      const depth = sheetDepth.has(row.parentCode)
        ? sheetDepth.get(row.parentCode)!
        : existing
          ? levelDepth.get(existing.levelId)
          : undefined;
      if (depth === undefined) {
        reject(
          row.row,
          row.code,
          `${subject}: missing parent; no unit has the code ${row.parentCode}.`,
        );
        continue;
      }
      if (depth >= row.depth) {
        reject(
          row.row,
          row.code,
          `${subject}: its level must be below the level of its parent ${row.parentCode}.`,
        );
        continue;
      }
      parent = { id: existing?.id ?? null, depth };
    }
    const unit = current.get(row.code);
    const parentId = parent ? parent.id : null;
    const moved = parent !== null && parentId === null;
    let status: Exclude<Status, "reject">;
    let reason = "";
    if (unit) {
      if (unit.levelId !== row.levelId) {
        reject(
          row.row,
          row.code,
          `${subject}: the import cannot change a unit's level.`,
        );
        continue;
      }
      if (moved || unit.parentId !== parentId) {
        status = "owner";
        reason = `${subject}: moves the unit to another parent.`;
      } else status = unit.name === row.name ? "unchanged" : "update";
    } else {
      const before = latest.get(row.code);
      if (before && (moved || before.parentId !== parentId)) {
        status = "owner";
        reason = `${subject}: reuses the code of an earlier unit under another parent.`;
      } else status = "create";
    }
    const written =
      group === "normal" ? status !== "owner" : status === "owner";
    if (
      written &&
      status !== "unchanged" &&
      moved &&
      !createdBy(group, plan.statuses.get(row.parentCode!))
    ) {
      reject(
        row.row,
        row.code,
        `${subject}: ${waitingReason(group, `its parent ${row.parentCode}`)}.`,
      );
      continue;
    }
    settle(row.row, row.code, status, reason, {
      id: unit?.id ?? null,
      code: row.code,
      name: row.name,
      levelId: row.levelId,
      depth: row.depth,
      parent: parent
        ? parent.id
          ? { id: parent.id }
          : { code: row.parentCode! }
        : null,
    });
  }
  return plan;
}

/**
 * Where a workbook reference points: a current row's id, a row this step creates (by code), or a
 * reason it cannot be used. waiting is a workbook row another step creates.
 */
function resolve(
  code: string,
  current: { id: string } | undefined,
  status: Status | undefined,
  group: ImportGroup,
): { ref: Ref } | { waiting: true } | { rejected: true } | { unknown: true } {
  if (current) return { ref: { id: current.id } };
  if (status === undefined) return { unknown: true };
  if (status === "reject") return { rejected: true };
  return createdBy(group, status) ? { ref: { code } } : { waiting: true };
}

function planPositions(
  book: Workbook,
  state: State,
  group: ImportGroup,
  unitStatuses: Map<string, Status>,
  architecture: JobArchitectureBody | null,
) {
  const { plan, reject, settle } = sheetPlan<PositionWrite>("Positions", group);
  // A Job title cell is a published title's key or name, ignoring case; names are not unique.
  type Title = JobArchitectureBody["titles"][number];
  const titleByKey = new Map<string, Title>();
  const titlesByName = new Map<string, Title[]>();
  for (const title of architecture?.titles ?? []) {
    titleByKey.set(title.key, title);
    const name = title.name.toLowerCase();
    titlesByName.set(name, [...(titlesByName.get(name) ?? []), title]);
  }
  const gradeNames = new Map(
    (architecture?.grades ?? []).map((grade) => [grade.code, grade.name]),
  );
  const units = new Map(state.units.map((unit) => [unit.code, unit]));
  const current = new Map(state.positions.map((row) => [row.code, row]));
  const latest = new Map(state.positionLatest.map((row) => [row.code, row]));
  const twice = duplicates(
    book.positions.map((row) => ({ key: isInvalid(row) ? row.key : row.code })),
  );
  for (const row of book.positions) {
    if (isInvalid(row)) {
      reject(row.row, row.key, row.reason);
      continue;
    }
    const subject = `Position ${row.code}`;
    if (twice.has(row.code)) {
      reject(
        row.row,
        row.code,
        `${subject}: duplicate code; it is on more than one row.`,
      );
      continue;
    }
    let title: Title | null = null;
    if (row.jobTitle !== null) {
      const cell = row.jobTitle.toLowerCase();
      const matches = new Set(titlesByName.get(cell));
      const byKey = titleByKey.get(cell);
      if (byKey) matches.add(byKey);
      if (matches.size !== 1) {
        reject(
          row.row,
          row.code,
          matches.size
            ? `${subject}: job title "${row.jobTitle}" matches more than one job title; use its key.`
            : `${subject}: unknown job title "${row.jobTitle}".`,
        );
        continue;
      }
      [title] = matches;
    }
    if (row.grade !== null) {
      if (!title) {
        reject(row.row, row.code, `${subject}: Grade needs a Job title.`);
        continue;
      }
      if (row.grade.toLowerCase() !== title.gradeCode.toLowerCase()) {
        reject(
          row.row,
          row.code,
          `${subject}: grade "${row.grade}" does not agree with grade ${title.gradeCode} of job title ${title.name}.`,
        );
        continue;
      }
    }
    const unit = resolve(
      row.unitCode,
      units.get(row.unitCode),
      unitStatuses.get(row.unitCode),
      group,
    );
    if ("unknown" in unit || "rejected" in unit) {
      reject(
        row.row,
        row.code,
        "unknown" in unit
          ? `${subject}: unknown unit code ${row.unitCode}.`
          : `${subject}: its unit ${row.unitCode} is rejected.`,
      );
      continue;
    }
    const target = "ref" in unit && "id" in unit.ref ? unit.ref.id : null;
    const position = current.get(row.code);
    let status: Exclude<Status, "reject">;
    let reason = "";
    if (position) {
      const moves = target !== position.unitId;
      if (moves && position.held) {
        status = "owner";
        reason = `${subject}: moves a position that an employee linked to a user holds.`;
      } else
        status =
          moves ||
          position.title !== row.title ||
          (row.manager !== null && row.manager !== position.isManager) ||
          (title !== null && title.key !== position.jobTitleKey)
            ? "update"
            : "unchanged";
    } else {
      const before = latest.get(row.code);
      if (before?.held && before.unitId !== target) {
        status = "owner";
        reason = `${subject}: reuses the code of an earlier position that an employee linked to a user holds, in another unit.`;
      } else status = "create";
    }
    const written =
      group === "normal" ? status !== "owner" : status === "owner";
    if (written && status !== "unchanged" && "waiting" in unit) {
      reject(
        row.row,
        row.code,
        `${subject}: ${waitingReason(group, `its unit ${row.unitCode}`)}.`,
      );
      continue;
    }
    settle(row.row, row.code, status, reason, {
      id: position?.id ?? null,
      code: row.code,
      title: row.title,
      isManager: row.manager,
      unit:
        "ref" in unit && !(position && target === position.unitId)
          ? unit.ref
          : null,
      jobTitleKey: title?.key ?? null,
    });
    if (title)
      plan.jobTitles.push({
        row: row.row,
        code: row.code,
        titleKey: title.key,
        titleName: title.name,
        gradeCode: title.gradeCode,
        gradeName: gradeNames.get(title.gradeCode)!,
      });
  }
  return plan;
}

function planEmployees(
  book: Workbook,
  state: State,
  group: ImportGroup,
  positionStatuses: Map<string, Status>,
) {
  const { plan, reject, settle } = sheetPlan<EmployeeWrite>("Employees", group);
  const positions = new Map(state.positions.map((row) => [row.code, row]));
  const current = new Map(state.employees.map((row) => [row.number, row]));
  const twice = duplicates(
    book.employees.map((row) => ({
      key: isInvalid(row) ? row.key : row.number,
    })),
  );
  rows: for (const row of book.employees) {
    if (isInvalid(row)) {
      reject(row.row, row.key, row.reason);
      continue;
    }
    const subject = `Employee ${row.number}`;
    const employee = current.get(row.number);
    if (twice.has(row.number)) {
      reject(
        row.row,
        row.number,
        `${subject}: duplicate employee number; it is on more than one row.`,
      );
      continue;
    }
    if (employee?.archived) {
      reject(
        row.row,
        row.number,
        `${subject}: archived employee; the import does not change archived employees.`,
      );
      continue;
    }
    const wanted: { ref: Ref; primary: boolean }[] = [];
    let waiting: string | null = null;
    for (const code of row.codes ?? []) {
      const position = resolve(
        code,
        positions.get(code),
        positionStatuses.get(code),
        group,
      );
      if ("unknown" in position || "rejected" in position) {
        reject(
          row.row,
          row.number,
          "unknown" in position
            ? `${subject}: unknown position code ${code}.`
            : `${subject}: its position ${code} is rejected.`,
        );
        continue rows;
      }
      if ("waiting" in position) waiting ??= code;
      else wanted.push({ ref: position.ref, primary: code === row.primary });
    }
    const facts =
      !employee ||
      employee.name !== row.name ||
      (row.email !== null && row.email !== employee.email) ||
      (row.phone !== null && row.phone !== employee.phone);
    // A non-blank Position codes is the whole set of current positions, as setEmployeePositions.
    const moves =
      row.codes !== null &&
      (!employee ||
        waiting !== null ||
        wanted.length !== employee.positions.length ||
        wanted.some(
          (entry) =>
            !("id" in entry.ref) ||
            !employee.positions.some(
              (held) =>
                held.positionId === (entry.ref as { id: string }).id &&
                held.primary === entry.primary,
            ),
        ));
    let status: Exclude<Status, "reject">;
    let reason = "";
    if (!employee) status = "create";
    else if (moves && employee.linked) {
      status = "owner";
      reason = `${subject}: changes the positions of an employee linked to a user.`;
    } else status = facts || moves ? "update" : "unchanged";
    const written =
      group === "normal" ? status !== "owner" : status === "owner";
    if (written && status !== "unchanged" && waiting !== null) {
      reject(
        row.row,
        row.number,
        `${subject}: ${waitingReason(group, `its position ${waiting}`)}.`,
      );
      continue;
    }
    settle(row.row, row.number, status, reason, {
      id: employee?.id ?? null,
      number: row.number,
      name: row.name,
      email: row.email,
      phone: row.phone,
      facts,
      positions: moves ? wanted : null,
      held: employee?.positions ?? [],
    });
  }
  return plan;
}

const chunks = <T>(rows: T[]) =>
  Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) =>
    rows.slice(i * CHUNK, (i + 1) * CHUNK),
  );
const recordset = (rows: object[]) => sql`${JSON.stringify(rows)}::jsonb`;
type Written = { created: number; updated: number };

/**
 * Units by level, top first, one insert and one update statement per level and chunk; units
 * created at a level are the parents the next level refers to by code. A normal step renames in
 * place; an owner step also sets the parent, which app.maintain_org_closure and the audit and
 * scope triggers handle as a move.
 */
async function writeUnits(
  tx: TeamTx,
  access: TenantAccess,
  writes: UnitWrite[],
  group: ImportGroup,
): Promise<Written> {
  const workspace = sql`${access.workspaceId}::uuid`;
  const created = new Map<string, string>();
  const parentId = (ref: Ref | null) => {
    if (!ref) return null;
    if ("id" in ref) return ref.id;
    const id = created.get(ref.code);
    if (!id) throw stateConflict();
    return id;
  };
  const result: Written = { created: 0, updated: 0 };
  for (const depth of [...new Set(writes.map((w) => w.depth))].sort(
    (a, b) => a - b,
  )) {
    const level = writes.filter((w) => w.depth === depth);
    for (const chunk of chunks(level.filter((w) => !w.id))) {
      const { rows } = await tx.execute<{ id: string; code: string }>(
        sql`insert into app.org_units as u (workspace_id, parent_id, level_id, name, code) select ${workspace}, r.parent_id, r.level_id, r.name, r.code from jsonb_to_recordset(${recordset(
          chunk.map((w) => ({
            parent_id: parentId(w.parent),
            level_id: w.levelId,
            name: w.name,
            code: w.code,
          })),
        )}) as r(parent_id uuid, level_id uuid, name text, code text) returning u.id, u.code`,
      );
      for (const row of rows) created.set(row.code, row.id);
      result.created += rows.length;
    }
    for (const chunk of chunks(level.filter((w) => w.id))) {
      const { rows } = await tx.execute(
        sql`update app.org_units u set name = r.name${group === "owner" ? sql`, parent_id = r.parent_id` : sql``} from jsonb_to_recordset(${recordset(
          chunk.map((w) => ({
            id: w.id,
            parent_id: parentId(w.parent),
            name: w.name,
          })),
        )}) as r(id uuid, parent_id uuid, name text) where u.id = r.id and u.workspace_id = ${workspace} and u.valid_to is null and u.archived_at is null returning u.id`,
      );
      if (rows.length !== chunk.length) throw stateConflict();
      result.updated += rows.length;
    }
  }
  return result;
}

/** Positions in current units, as createPosition, updatePosition and movePosition write them. */
async function writePositions(
  tx: TeamTx,
  access: TenantAccess,
  writes: PositionWrite[],
): Promise<Written> {
  const workspace = sql`${access.workspaceId}::uuid`;
  const unitId = (ref: Ref | null) => {
    if (ref && !("id" in ref)) throw stateConflict();
    return ref?.id ?? null;
  };
  const result: Written = { created: 0, updated: 0 };
  for (const chunk of chunks(writes.filter((w) => !w.id))) {
    const { rows } = await tx.execute(
      sql`insert into app.positions as p (workspace_id, org_unit_id, title, code, is_manager, job_role_team_id, job_role_id, job_title_key) select u.workspace_id, u.id, r.title, r.code, r.is_manager, null, null, r.job_title_key from jsonb_to_recordset(${recordset(
        chunk.map((w) => ({
          org_unit_id: unitId(w.unit),
          title: w.title,
          code: w.code,
          is_manager: w.isManager ?? false,
          job_title_key: w.jobTitleKey,
        })),
      )}) as r(org_unit_id uuid, title text, code text, is_manager boolean, job_title_key text) join app.org_units u on u.id = r.org_unit_id and u.workspace_id = ${workspace} and u.valid_to is null and u.archived_at is null returning p.id`,
    );
    if (rows.length !== chunk.length) throw stateConflict();
    result.created += rows.length;
  }
  for (const chunk of chunks(writes.filter((w) => w.id))) {
    const { rows } = await tx.execute(
      sql`update app.positions p set title = r.title, is_manager = coalesce(r.is_manager, p.is_manager), org_unit_id = coalesce(r.org_unit_id, p.org_unit_id), job_title_key = coalesce(r.job_title_key, p.job_title_key) from jsonb_to_recordset(${recordset(
        chunk.map((w) => ({
          id: w.id,
          org_unit_id: unitId(w.unit),
          title: w.title,
          is_manager: w.isManager,
          job_title_key: w.jobTitleKey,
        })),
      )}) as r(id uuid, org_unit_id uuid, title text, is_manager boolean, job_title_key text) where p.id = r.id and p.workspace_id = ${workspace} and p.valid_to is null and p.archived_at is null and (r.org_unit_id is null or exists (select 1 from app.org_units u where u.id = r.org_unit_id and u.workspace_id = ${workspace} and u.valid_to is null and u.archived_at is null)) returning p.id`,
    );
    if (rows.length !== chunk.length) throw stateConflict();
    result.updated += rows.length;
  }
  return result;
}

/**
 * Employees as createEmployee (source excel, active, standard, never a user link) and
 * updateEmployee write them, then each changed set of positions as setEmployeePositions replaces
 * it: ends and demotions before promotions and inserts, so the one-primary index holds per row.
 */
async function writeEmployees(
  tx: TeamTx,
  access: TenantAccess,
  writes: EmployeeWrite[],
): Promise<Written> {
  const workspace = sql`${access.workspaceId}::uuid`;
  const ids = new Map<string, string>();
  const result: Written = { created: 0, updated: 0 };
  for (const chunk of chunks(writes.filter((w) => !w.id))) {
    const { rows } = await tx.execute<{ id: string; number: string }>(
      sql`insert into app.employees as e (workspace_id, display_name, employee_number, work_email, work_phone, status, retention_class, left_at, user_id, source) select ${workspace}, r.display_name, r.employee_number, r.work_email, r.work_phone, 'active', 'standard', null, null, 'excel' from jsonb_to_recordset(${recordset(
        chunk.map((w) => ({
          display_name: w.name,
          employee_number: w.number,
          work_email: w.email,
          work_phone: w.phone,
        })),
      )}) as r(display_name text, employee_number text, work_email text, work_phone text) returning e.id, e.employee_number as number`,
    );
    for (const row of rows) ids.set(row.number, row.id);
    result.created += rows.length;
  }
  for (const chunk of chunks(writes.filter((w) => w.id && w.facts))) {
    const { rows } = await tx.execute(
      sql`update app.employees e set display_name = r.display_name, work_email = coalesce(r.work_email, e.work_email), work_phone = coalesce(r.work_phone, e.work_phone), ${leftAt()} from jsonb_to_recordset(${recordset(
        chunk.map((w) => ({
          id: w.id,
          display_name: w.name,
          work_email: w.email,
          work_phone: w.phone,
        })),
      )}) as r(id uuid, display_name text, work_email text, work_phone text) where e.id = r.id and e.workspace_id = ${workspace} and e.archived_at is null returning e.id`,
    );
    if (rows.length !== chunk.length) throw stateConflict();
  }
  result.updated = writes.filter((w) => w.id).length;
  type Change = { employee_id: string; position_id: string; primary: boolean };
  const removed: Change[] = [],
    unset: Change[] = [],
    promoted: Change[] = [],
    added: Change[] = [];
  for (const w of writes) {
    if (!w.positions) continue;
    const employee = w.id ?? ids.get(w.number);
    if (!employee) throw stateConflict();
    const wanted = new Map(
      w.positions.map((entry) => {
        if (!("id" in entry.ref)) throw stateConflict();
        return [entry.ref.id, entry.primary];
      }),
    );
    const change = (positionId: string, primary: boolean) => ({
      employee_id: employee,
      position_id: positionId,
      primary,
    });
    for (const held of w.held) {
      if (!wanted.has(held.positionId))
        removed.push(change(held.positionId, false));
      else if (held.primary && !wanted.get(held.positionId))
        unset.push(change(held.positionId, false));
      else if (!held.primary && wanted.get(held.positionId))
        promoted.push(change(held.positionId, true));
    }
    for (const [positionId, primary] of wanted)
      if (!w.held.some((held) => held.positionId === positionId))
        added.push(change(positionId, primary));
  }
  const rowsOf = (list: Change[]) =>
    sql`from jsonb_to_recordset(${recordset(list)}) as r(employee_id uuid, position_id uuid) where ep.employee_id = r.employee_id and ep.position_id = r.position_id and ep.workspace_id = ${workspace} and ep.valid_to is null`;
  for (const chunk of chunks(removed))
    await tx.execute(
      sql`update app.employee_positions ep set valid_to = now() ${rowsOf(chunk)}`,
    );
  for (const chunk of chunks(unset))
    await tx.execute(
      sql`update app.employee_positions ep set "primary" = false ${rowsOf(chunk)}`,
    );
  for (const chunk of chunks(promoted))
    await tx.execute(
      sql`update app.employee_positions ep set "primary" = true ${rowsOf(chunk)}`,
    );
  for (const chunk of chunks(added)) {
    const { rows } = await tx.execute(
      sql`insert into app.employee_positions (employee_id, position_id, workspace_id, "primary") select r.employee_id, r.position_id, h.workspace_id, r."primary" from jsonb_to_recordset(${recordset(chunk)}) as r(employee_id uuid, position_id uuid, "primary" boolean) join app.positions h on h.id = r.position_id and h.workspace_id = ${workspace} and h.valid_to is null and h.archived_at is null returning employee_id`,
    );
    if (rows.length !== chunk.length) throw stateConflict();
  }
  return result;
}

const SHEET_KEYS = {
  Units: "units",
  Positions: "positions",
  Employees: "employees",
} as const;

/** One sheet's outcome: the counts written, its rejected and owner-group rows, and job titles. */
export type SheetOutcome = Pick<
  SheetPlan<unknown>,
  "counts" | "rejected" | "needsOwner" | "jobTitles"
>;

/**
 * The internal write path of one sheet in the caller's transaction: reads the current rows, plans
 * the whole workbook against them and writes this sheet's rows of the group, then one audit row
 * with counts only when it wrote any. It makes no access check of its own; the triggers and RLS
 * still guard every row.
 */
export async function applyImportSheet(
  tx: TeamTx,
  p: Principal,
  access: TenantAccess,
  book: Workbook,
  sheet: ImportSheet,
  group: ImportGroup,
): Promise<SheetOutcome> {
  const plan = planImport(
    book,
    await readState(tx, access, book),
    group,
    jobArchitectureFor(access)?.body ?? null,
  )[sheet];
  const written =
    sheet === "Units"
      ? await writeUnits(tx, access, plan.writes as UnitWrite[], group)
      : sheet === "Positions"
        ? await writePositions(tx, access, plan.writes as PositionWrite[])
        : await writeEmployees(tx, access, plan.writes as EmployeeWrite[]);
  if (written.created + written.updated > 0)
    await tx.insert(activity).values({
      teamId: p.teamId,
      recordId: null,
      actorId: p.userId,
      actorType: "session",
      tokenId: null,
      action: "org-import.applied",
      kind: "org-import",
      summary: `Imported ${SHEET_KEYS[sheet]} from Excel`,
      metadata: {
        workspaceId: access.workspaceId,
        sheet: SHEET_KEYS[sheet],
        group,
        created: written.created,
        updated: written.updated,
        unchanged: plan.counts.unchanged,
        rejected: plan.counts.reject,
      },
    });
  return {
    counts: {
      ...plan.counts,
      create: written.created,
      update: written.updated,
      needsOwner: group === "owner" ? 0 : plan.counts.needsOwner,
    },
    rejected: plan.rejected,
    needsOwner: group === "owner" ? [] : plan.needsOwner,
    jobTitles: plan.jobTitles,
  };
}

/**
 * The caller checks: a session of a company owner or of a company admin with the organisation
 * area (org_forbidden), a company owner for the owner step (org_owner_required), and for apply a
 * scope the activity policy accepts (org_import_forbidden).
 */
function requireCaller(
  p: Principal,
  access: TenantAccess,
  step: "dry-run" | ImportGroup,
) {
  requireWrite(p, access);
  if (step === "owner") requireWrite(p, access, true);
  if (
    step !== "dry-run" &&
    !access.scopes.some((scope) => AUDIT_SCOPES.includes(scope))
  )
    throw importForbidden();
}

/** Before the body is read or parsed: the caller checks in a transaction that reads no row. */
export async function requireImportCaller(
  p: Principal,
  step: "dry-run" | ImportGroup,
) {
  await inOrg(p, async (_tx, access) => requireCaller(p, access, step));
}

/**
 * The checks every import transaction makes again before reading any row: the caller checks, and
 * directory create and edit when there are employee rows (directory_forbidden).
 */
function requireImport(
  p: Principal,
  access: TenantAccess,
  book: Workbook,
  step: "dry-run" | ImportGroup,
) {
  requireCaller(p, access, step);
  if (book.employees.length) {
    requireDirectory(p, access, "create");
    requireDirectory(p, access, "edit");
  }
}

function report(
  book: Workbook,
  sheets: Record<ImportSheet, SheetOutcome>,
): ImportReport {
  // By sheet, then by row.
  const list = (key: "rejected" | "needsOwner") =>
    IMPORT_SHEETS.flatMap((sheet) =>
      [...sheets[sheet][key]].sort((a, b) => a.row - b.row),
    );
  const rejected = list("rejected");
  const needsOwner = list("needsOwner");
  const { flagged, ignored } = book;
  const jobTitles = [...sheets.Positions.jobTitles].sort(
    (a, b) => a.row - b.row,
  );
  return {
    sha256: book.sha256,
    sheets: {
      units: sheets.Units.counts,
      positions: sheets.Positions.counts,
      employees: sheets.Employees.counts,
    },
    rejected: rejected.slice(0, LIST_LIMIT),
    needsOwner: needsOwner.slice(0, LIST_LIMIT),
    flagged: flagged.slice(0, LIST_LIMIT),
    jobTitles: jobTitles.slice(0, LIST_LIMIT),
    ignored: ignored.slice(0, LIST_LIMIT),
    truncated: [rejected, needsOwner, flagged, jobTitles, ignored].some(
      (list) => list.length > LIST_LIMIT,
    ),
  };
}

/** The dry run: one transaction, read only from the statement after install; it writes nothing. */
export async function dryRunOrgImport(
  p: Principal,
  book: Workbook,
): Promise<ImportReport> {
  return inOrg(p, async (tx, access) => {
    await tx.execute(
      sql`select set_config('transaction_read_only', 'on', true)`,
    );
    requireImport(p, access, book, "dry-run");
    const plan = planImport(
      book,
      await readState(tx, access, book),
      "normal",
      jobArchitectureFor(access)?.body ?? null,
    );
    return report(book, plan);
  });
}

/**
 * Applies the create and update rows (normal) or only the rows that need a company owner (owner),
 * re-planned against the data as it is now, in one transaction per sheet: units, positions, then
 * employees. A failure after a committed sheet says which sheets were applied; re-running is safe.
 */
export async function applyOrgImport(
  p: Principal,
  book: Workbook,
  group: ImportGroup,
): Promise<ImportReport & { group: ImportGroup }> {
  const sheets = {} as Record<ImportSheet, SheetOutcome>;
  const applied: ImportSheet[] = [];
  for (const sheet of IMPORT_SHEETS) {
    const work = async (tx: TeamTx, access: TenantAccess) => {
      requireImport(p, access, book, group);
      return applyImportSheet(tx, p, access, book, sheet, group);
    };
    try {
      sheets[sheet] =
        sheet === "Units"
          ? await inOrg(p, work)
          : await inDirectory(p, directoryOwnerRequired, work);
    } catch (error) {
      if (applied.length) throw stopped(error, applied);
      throw error;
    }
    applied.push(sheet);
  }
  return { ...report(book, sheets), group };
}

/** A later sheet's failure, with the sheets already applied named. */
function stopped(error: unknown, applied: ImportSheet[]) {
  const note = ` The ${applied.join(" and ")} ${applied.length > 1 ? "sheets were" : "sheet was"} already applied; applying the same file again is safe.`;
  if (error instanceof ApiError)
    return new ApiError(error.status, error.code, error.message + note);
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  console.error(
    `org_import_incomplete category=${(error as { constructor?: { name?: string } } | null)?.constructor?.name || typeof error}${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` sqlstate=${code}` : ""}`,
  );
  return new ApiError(
    500,
    "internal_error",
    `The import could not finish.${note}`,
  );
}
