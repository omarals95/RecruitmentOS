import { createHash } from "node:crypto";
import { DrizzleQueryError, sql } from "drizzle-orm";
import {
  beginCvUpload,
  completeCvUpload,
  putCvBytes,
  readVerifiedCv,
  readyCv,
  readyCvsOf,
  storageBinding,
  type CvDto,
} from "@/lib/cvs";
import { extractCvText, hasReadableText } from "@/lib/cv-text";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import { CvValidationError, validateCvMetadata } from "@/lib/storage-format";

type TextTool = "get_cv_text" | "get_cv_texts";
/** A candidate's ready CV with its 1-based place among them, oldest first. */
export type NumberedCv = {
  id: string;
  candidateId: string;
  originalName: string;
  mimeType: string;
  completedAt: string;
  version: number;
  latest: boolean;
};

/** Test hooks may shorten these; routes never change them. */
export const cvTextLimits = {
  perCvCharacters: 30_000,
  perCallCharacters: 150_000,
  callMs: 25_000,
  readMs: 15_000,
  extractionMs: 10_000,
};
export const MAX_MCP_CV_BYTES = 3 * 1024 * 1024;
const NOT_AVAILABLE =
  "Text is not available for this file. Open it in RecruitmentOS.";
const NOT_READ =
  "This CV was not read because this call ran out of its character or time budget. Ask again for the remaining CVs.";

/** The call's remaining characters and its deadline; each CV takes from both. */
export function textBudget() {
  return {
    characters: cvTextLimits.perCallCharacters,
    deadline: Date.now() + cvTextLimits.callMs,
  };
}
type Budget = ReturnType<typeof textBudget>;

const notFound = () =>
  new ApiError(
    404,
    "not_found",
    "This CV is not available in the selected team.",
  );
/** Another team's, erased, missing or not-ready CVs and candidates all read as not_found. */
function asNotFound(error: unknown): never {
  if (
    error instanceof ApiError &&
    ["CV_NOT_FOUND", "CANDIDATE_NOT_FOUND"].includes(error.code)
  )
    throw notFound();
  throw error;
}

/** Each candidate's ready CVs numbered by completion; a candidate the team does not have is left out. */
export async function numberedCvs(p: Principal, candidateIds: string[]) {
  const found = await readyCvsOf(p, candidateIds).catch(asNotFound);
  return new Map(
    [...found].map(([candidateId, cvs]) => [
      candidateId,
      cvs.map((cv, index): NumberedCv => ({
        ...cv,
        version: index + 1,
        latest: index === cvs.length - 1,
      })),
    ]),
  );
}

/** One CV by its ID, numbered among its candidate's ready CVs. */
export async function numberedCv(p: Principal, cvId: string) {
  const row = await readyCv(p, cvId).catch(asNotFound);
  const cv = (await numberedCvs(p, [row.candidateId]))
    .get(row.candidateId)
    ?.find((item) => item.id === cvId);
  if (!cv) throw notFound();
  return cv;
}

function described(cv: NumberedCv | null, candidateId: string) {
  return {
    candidateId,
    cvId: cv?.id ?? null,
    fileName: cv?.originalName ?? null,
    mimeType: cv?.mimeType ?? null,
    version: cv?.version ?? null,
    latest: cv?.latest ?? null,
    uploadedAt: cv?.completedAt ?? null,
  };
}
export const noCv = (candidateId: string) => ({
  ...described(null, candidateId),
  status: "no_cv" as const,
});
export const notRead = (cv: NumberedCv) => ({
  ...described(cv, cv.candidateId),
  status: "not_read" as const,
  message: NOT_READ,
});
export const itemError = (
  candidateId: string,
  cv: NumberedCv | null,
  code: string,
) => ({
  ...described(cv, candidateId),
  status: "error" as const,
  code,
});

/** The team turned CV text access off; the whole call stops. */
export class CvTextAccessOff extends Error {}
export const ACCESS_OFF_MESSAGE =
  "Your team does not allow connected AI apps to read CV contents. A team owner or admin can change this in Settings > Team & access.";

/**
 * Reads one CV's text in this order: reauthorize the read, commit its audit row, read the verified
 * object, extract. No byte is read before the audit row commits. The text is never stored.
 */
export async function cvText(
  p: Principal,
  tool: TextTool,
  cv: NumberedCv,
  budget: Budget,
) {
  if (budget.characters < 1 || budget.deadline - Date.now() < 1)
    return notRead(cv);
  const row = await readyCv(p, cv.id).catch(asNotFound);
  try {
    await withTeam(p, (tx) =>
      tx.execute(
        sql`select tenant_context.audit_mcp_cv_read(${tool}, ${cv.id}::uuid)`,
      ),
    );
  } catch (error) {
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    const code = (cause as { code?: unknown } | undefined)?.code;
    if (code === "RQ003") throw new CvTextAccessOff();
    // The scopes were checked above, so a refusal here means the CV stopped being readable.
    if (code === "42501") throw notFound();
    throw error;
  }
  const notAvailable = {
    ...described(cv, cv.candidateId),
    status: "text_not_available" as const,
    message: NOT_AVAILABLE,
  };
  if (!hasReadableText(row.mimeType)) return notAvailable;
  // Each step gets at most what is left of the call's time.
  const left = () => budget.deadline - Date.now();
  if (left() < 1) return notRead(cv);
  const bytes = await readVerifiedCv(
    p,
    row,
    Math.min(cvTextLimits.readMs, left()),
  );
  if (!bytes) return notAvailable;
  if (left() < 1) return notRead(cv);
  const result = await extractCvText(
    row.mimeType,
    bytes,
    Math.min(cvTextLimits.extractionMs, left()),
    Math.min(cvTextLimits.perCvCharacters, budget.characters),
  );
  if (!result) return notAvailable;
  const characters = Array.from(result.text).length;
  budget.characters -= characters;
  return {
    ...described(cv, cv.candidateId),
    status: "text" as const,
    text: result.text,
    characters,
    truncated: result.truncated,
  };
}

/** A deterministic UUID (RFC 9562 version 8) for one name, so a retry reuses the same reservation. */
export function derivedId(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex").slice(0, 32);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Strict standard base64, decoded; a file over 3 MiB is refused before anything is reserved. */
export function decodedFile(contentBase64: string): Buffer {
  if (
    contentBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
  )
    throw new ApiError(
      400,
      "invalid_input",
      "contentBase64: send the file as standard base64.",
    );
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > MAX_MCP_CV_BYTES)
    throw new ApiError(
      413,
      "cv_too_large_for_mcp",
      "This file is larger than 3 MB. Use create_cv_upload_link to upload files up to 10 MB, or upload it in RecruitmentOS.",
    );
  return bytes;
}

/** Base64 uploads are stored server-side, which only the Blob binding supports. */
export function requireBlobUpload() {
  if (storageBinding().provider !== "blob")
    throw new ApiError(
      409,
      "cv_upload_link_required",
      "This storage does not accept CV bytes sent through MCP. Use create_cv_upload_link instead.",
    );
}

/** The file checks of every upload, run before a new candidate is created for the file. */
export function checkedFile(
  originalName: string,
  mimeType: string,
  size: number,
) {
  try {
    return validateCvMetadata(originalName, mimeType, size);
  } catch (error) {
    if (error instanceof CvValidationError)
      throw new ApiError(400, "INVALID_CV", error.message);
    throw error;
  }
}

export function cvSummary(cv: CvDto) {
  return {
    id: cv.id,
    candidateId: cv.candidateId,
    originalName: cv.originalName,
    mimeType: cv.mimeType,
    sizeBytes: cv.sizeBytes,
    status: cv.status,
  };
}

/** Stores the reserved file's bytes and completes it unchanged; a ready replay writes nothing. */
export async function storeAndComplete(
  p: Principal,
  reserved: Awaited<ReturnType<typeof beginCvUpload>>,
  bytes: Buffer,
) {
  if (reserved.data.status === "ready") return cvSummary(reserved.data);
  await putCvBytes(p, reserved.data.id, bytes);
  return cvSummary(await completeCvUpload(p, reserved.data.id));
}
