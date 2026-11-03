import {
  lstat,
  realpath,
  stat,
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, relative, join, extname, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import readXlsx from "read-excel-file/node";
import {
  buildPlan,
  text,
  type LegacyInputs,
  type MigrationPlan,
  type Source,
} from "./plan";

const MAX_WORKBOOK = 100 * 1024 * 1024,
  MAX_CV = 10 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".pages": "application/vnd.apple.pages",
};
function inside(root: string, target: string) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function missing(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Validate every existing component, including Windows junctions; never follow an imported link. */
export async function safeResolve(
  rootInput: string,
  relativePath: string,
): Promise<string> {
  if (
    !relativePath ||
    /^[\\/]|^[a-z]:/i.test(relativePath) ||
    relativePath.includes(":") ||
    Array.from(relativePath).some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error(
      "Source path must be relative to the explicitly selected root.",
    );
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error("Unsafe source path component.");
  const root = await realpath(rootInput),
    rootInfo = await lstat(rootInput);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(
      "The selected root must be a real directory, not a link or junction.",
    );
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error("Source links and junctions are not allowed.");
      const actual = await realpath(current);
      if (!inside(root, actual))
        throw new Error("Source resolved outside the selected root.");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const target = resolve(root, ...parts);
  if (!inside(root, target))
    throw new Error("Source resolved outside the selected root.");
  return target;
}

/** Reject oversized/ZIP64/encrypted XLSX input before a ZIP parser expands it. */
export function validateWorkbookZip(bytes: Buffer): void {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0)
    throw new Error("Workbook is not a supported XLSX ZIP archive.");
  const entries = bytes.readUInt16LE(eocd + 10),
    size = bytes.readUInt32LE(eocd + 12),
    offset = bytes.readUInt32LE(eocd + 16);
  if (
    entries === 65535 ||
    entries > 10000 ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size > eocd
  )
    throw new Error("Workbook archive exceeds supported limits.");
  let pointer = offset,
    total = 0;
  for (let i = 0; i < entries; i++) {
    if (
      pointer + 46 > bytes.length ||
      bytes.readUInt32LE(pointer) !== 0x02014b50
    )
      throw new Error("Invalid workbook archive directory.");
    const flags = bytes.readUInt16LE(pointer + 8),
      compressed = bytes.readUInt32LE(pointer + 20),
      expanded = bytes.readUInt32LE(pointer + 24);
    if (
      flags & 1 ||
      expanded > 64 * 1024 * 1024 ||
      expanded === 0xffffffff ||
      expanded > Math.max(1, compressed) * 1000
    )
      throw new Error(
        "Workbook archive contains an unsupported or oversized entry.",
      );
    total += expanded;
    if (total > 256 * 1024 * 1024)
      throw new Error("Expanded workbook exceeds 256MiB.");
    pointer +=
      46 +
      bytes.readUInt16LE(pointer + 28) +
      bytes.readUInt16LE(pointer + 30) +
      bytes.readUInt16LE(pointer + 32);
    if (pointer > offset + size)
      throw new Error("Invalid workbook archive lengths.");
  }
}
async function readStable(path: string, max: number): Promise<Buffer> {
  const before = await stat(path);
  if (!before.isFile() || before.size > max)
    throw new Error("Input file is not a regular file within its size limit.");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const fileStat = await handle.stat();
    if (fileStat.size !== before.size || fileStat.mtimeMs !== before.mtimeMs)
      throw new Error("Input changed before reading.");
    const bytes = await handle.readFile();
    const after = await stat(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytes.length !== before.size
    )
      throw new Error(
        "Input changed while reading; close the legacy application and save Excel.",
      );
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function readSourceBytes(
  plan: MigrationPlan,
  source: Source,
): Promise<Buffer> {
  if (!plan.root || !source.relativePath)
    throw new Error("Source has no approved local path.");
  const path = await safeResolve(plan.root, source.relativePath),
    info = await stat(path);
  if (info.size !== source.sizeBytes || info.mtimeMs !== source.mtimeMs)
    throw new Error("CV changed since reconciliation; run a fresh dry-run.");
  const bytes = await readStable(path, MAX_CV);
  if (
    source.sha256 &&
    createHash("sha256").update(bytes).digest("hex") !== source.sha256
  )
    throw new Error(
      "CV does not match the File Inventory SHA-256; review its version.",
    );
  return bytes;
}

export async function loadLegacy(
  rootInput: string,
  appDirectory = "Recruiter Dashboard",
): Promise<MigrationPlan> {
  const root = await realpath(rootInput);
  await safeResolve(rootInput, "Resume_Master.xlsx");
  const inputs: LegacyInputs = {
    workbooks: {},
    states: [],
    recovered: {},
    issues: [],
  };
  const error = (code: string, location: string, message: string) =>
    inputs.issues.push({ severity: "error", code, location, message });
  for (const filename of [
    "Resume_Master.xlsx",
    "Recruitment_Tasks.xlsx",
    "Recruitment_Vacancies.xlsx",
    "Recruitment_Operations.xlsx",
  ]) {
    try {
      const path = await safeResolve(root, filename),
        bytes = await readStable(path, MAX_WORKBOOK);
      validateWorkbookZip(bytes);
      const sheets = await readXlsx(bytes),
        data: Record<string, unknown[][]> = {};
      let cells = 0;
      for (const sheet of sheets) {
        if (data[sheet.sheet])
          throw new Error("Workbook contains duplicate sheet names.");
        cells += sheet.data.reduce((n, row) => n + row.length, 0);
        if (cells > 2000000 || sheet.data.length > 100000)
          throw new Error(
            "Workbook exceeds the bounded migration row/cell limit.",
          );
        data[sheet.sheet] = sheet.data;
      }
      inputs.workbooks[filename] = data;
    } catch (err) {
      if (missing(err) && filename !== "Resume_Master.xlsx")
        inputs.issues.push({
          severity: "warning",
          code: "OPTIONAL_WORKBOOK_MISSING",
          location: filename,
          message:
            "Optional legacy workbook is absent; its resource count will be zero.",
        });
      else
        error(
          "WORKBOOK_UNREADABLE",
          filename,
          err instanceof Error ? err.message : "Workbook could not be read.",
        );
    }
  }
  try {
    const path = await safeResolve(root, `${appDirectory}/recovered.json`),
      parsed: unknown = JSON.parse(
        (await readStable(path, 5 * 1024 * 1024)).toString("utf8"),
      );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => typeof v !== "string")
    )
      throw new Error(
        "recovered.json must map source IDs to relative recovered filenames.",
      );
    inputs.recovered = parsed as Record<string, string>;
  } catch (err) {
    if (!missing(err))
      error(
        "RECOVERY_MAPPING_UNREADABLE",
        `${appDirectory}/recovered.json`,
        err instanceof Error ? err.message : "Invalid recovery mapping.",
      );
  }
  try {
    const path = await safeResolve(
      root,
      `${appDirectory}/recruiter-state.sqlite3`,
    );
    const bytes = await readStable(path, 100 * 1024 * 1024);
    for (const suffix of ["-wal", "-journal"]) {
      try {
        const sidecar = await safeResolve(
          root,
          `${appDirectory}/recruiter-state.sqlite3${suffix}`,
        );
        if ((await stat(sidecar)).size > 0)
          throw new Error(
            "SQLite has a live WAL/journal. Close the old dashboard cleanly before importing; do not delete sidecars.",
          );
      } catch (err) {
        if (!missing(err)) throw err;
      }
    }
    const scratch = await mkdtemp(join(tmpdir(), "ros-legacy-state-"));
    try {
      const copy = join(scratch, "state.sqlite3");
      await writeFile(copy, bytes, { mode: 0o600, flag: "wx" });
      const db = new DatabaseSync(copy, { readOnly: true });
      try {
        const rows = db
          .prepare(
            "SELECT id,shortlisted,status,note,updated FROM candidates LIMIT 100001",
          )
          .all();
        if (rows.length > 100000)
          throw new Error("SQLite state exceeds 100000 rows.");
        inputs.states = rows.map((row) => {
          if (row.shortlisted !== 0 && row.shortlisted !== 1)
            throw new Error("SQLite shortlist values must be 0 or 1.");
          return {
            id: text(row.id),
            shortlisted: row.shortlisted === 1,
            status: text(row.status),
            note: row.note === null ? "" : String(row.note),
            updated: text(row.updated),
          };
        });
      } finally {
        db.close();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } catch (err) {
    if (missing(err))
      inputs.issues.push({
        severity: "warning",
        code: "PRIVATE_STATE_MISSING",
        location: `${appDirectory}/recruiter-state.sqlite3`,
        message:
          "No personal legacy state was found. If the dashboard folder has another name, use --app-dir.",
      });
    else
      error(
        "PRIVATE_STATE_UNREADABLE",
        `${appDirectory}/recruiter-state.sqlite3`,
        err instanceof Error ? err.message : "Private state could not be read.",
      );
  }
  const plan = buildPlan(inputs);
  plan.root = root;
  const sourceMap = new Map(plan.sources.map((source) => [source.id, source]));
  const locate = (source: Source, visited: Set<string>): string => {
    if (visited.has(source.id))
      throw new Error("Canonical source references form a cycle.");
    visited.add(source.id);
    if (inputs.recovered[source.id]) {
      const recovered = inputs.recovered[source.id].replace(/\\/g, "/");
      if (!recovered.startsWith("Recovered Resumes/"))
        throw new Error(
          "Recovered source must stay in the immutable Recovered Resumes folder.",
        );
      return `${appDirectory}/${recovered}`;
    }
    const original = text(source.row["Relative source path / attachment"]);
    if (!original.includes(" > ")) return original;
    const canonical = text(source.row["Canonical source ID"]);
    if (canonical && canonical !== source.id && sourceMap.has(canonical))
      return locate(sourceMap.get(canonical)!, visited);
    return original.split(" > ")[0];
  };
  const sourcePathOwners = new Map<string, string[]>();
  for (const source of plan.sources) {
    try {
      source.relativePath = locate(source, new Set()).replace(/\\/g, "/");
      const path = await safeResolve(root, source.relativePath),
        info = await stat(path);
      if (!info.isFile()) throw new Error("Source is not a regular file.");
      source.exists = true;
      source.sizeBytes = info.size;
      source.mtimeMs = info.mtimeMs;
      source.mimeType = MIME[extname(path).toLowerCase()];
      source.uploadable =
        !!source.mimeType &&
        info.size > 0 &&
        info.size <= MAX_CV &&
        source.candidateIds.length === 1;
      const sha = text(source.row["SHA-256"]);
      if (sha && /^[a-f0-9]{64}$/i.test(sha)) source.sha256 = sha.toLowerCase();
      else if (sha)
        plan.issues.push({
          severity: "warning",
          code: "INVALID_SOURCE_HASH",
          location: `Source:${source.id}`,
          message:
            "Source hash is not SHA-256 and will not be used for verification.",
        });
      if (
        source.id.length > 180 ||
        source.relativePath.length > 1000 ||
        path.split(sep).at(-1)!.length > 180
      )
        source.uploadable = false;
      if (!source.uploadable)
        plan.issues.push({
          severity: "warning",
          code: "SOURCE_NOT_UPLOADABLE",
          location: `Source:${source.id}`,
          message: !source.mimeType
            ? "Supporting/unsupported source type is retained as provenance and not uploaded."
            : source.candidateIds.length !== 1
              ? "CV must link to exactly one candidate before upload."
              : "CV is empty, exceeds the 10MiB limit, or its source ID/name/path exceeds storage metadata limits.",
        });
      const key = path.toLowerCase();
      const owner = sourcePathOwners.get(key) || [];
      owner.push(source.id);
      sourcePathOwners.set(key, owner);
    } catch (err) {
      source.exists = false;
      source.uploadable = false;
      plan.issues.push({
        severity: "warning",
        code: "SOURCE_UNAVAILABLE",
        location: `Source:${source.id}`,
        message:
          err instanceof Error ? err.message : "Source is missing/unreadable.",
      });
    }
  }
  for (const ids of sourcePathOwners.values())
    if (ids.length > 1)
      plan.issues.push({
        severity: "warning",
        code: "DUPLICATE_PHYSICAL_SOURCE",
        location: ids.join(";"),
        message:
          "Multiple source IDs resolve to the same physical file; provenance is retained and upload will reuse one logical file per candidate.",
      });
  for (const record of plan.records) {
    if (record.resource === "candidates")
      record.importMeta.resolvedSources = plan.sources
        .filter((s) => record.sources?.includes(s.id))
        .map((s) => ({
          id: s.id,
          relativePath: s.relativePath || "",
          exists: !!s.exists,
          uploadable: !!s.uploadable,
          sizeBytes: s.sizeBytes ?? null,
          sha256: s.sha256 || "",
        }));
    if (
      JSON.stringify(record.importMeta).length > 200000 ||
      Buffer.byteLength(
        JSON.stringify({
          data: record.data,
          importMeta: record.importMeta,
          customValues: record.customValues,
        }),
        "utf8",
      ) > 240000
    )
      plan.issues.push({
        severity: "error",
        code: "IMPORT_PAYLOAD_TOO_LARGE",
        location: `${record.resource}:${record.legacyId}`,
        message:
          "Lossless source data exceeds bounded API payload limits; split/review before applying.",
      });
  }
  plan.stats.uploadableSources = plan.sources.filter(
    (s) => s.uploadable,
  ).length;
  plan.stats.missingSources = plan.sources.filter((s) => !s.exists).length;
  return plan;
}
