import { createHash, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { activity } from "@/db/schema";
import type { TeamTx } from "@/db";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import { extractionProvider, type ExtractionProvider } from "@/lib/ai-provider";
import {
  CvValidationError,
  MAX_CV_BYTES,
  validateCvBytes,
  validateCvMetadata,
} from "@/lib/storage-format";
import {
  AI_EXTRACTION_DATA_SENT,
  AI_EXTRACTION_LIMITS,
  AI_EXTRACTION_LIMITS_TEXT,
  AI_EXTRACTION_PURPOSE,
  extractedCandidateFieldsSchema,
  runCandidateExtraction,
  type ExtractedCandidateFields,
  type ExtractionDisclosure,
  type ExtractionError,
} from "@/domain/cv-extraction";
import { uuidSchema } from "@/domain/records";

type Field = keyof ExtractedCandidateFields;
export type ConsentStatus = "none" | "granted" | "withdrawn" | "outdated";
const KIND = "ai-extraction";
const GRANTED = "ai.consent_granted";
const WITHDRAWN = "ai.consent_withdrawn";
const STARTED = "ai.extraction_started";
const FINISHED = "ai.extraction_finished";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const consentInputSchema = z
  .object({
    decision: z.enum(["grant", "withdraw"]),
    disclosureVersion: sha256Hex.nullable(),
  })
  .strict();
export const extractionJobSchema = z
  .object({
    requestId: uuidSchema,
    disclosureVersion: sha256Hex,
    file: z
      .object({
        originalName: z.string().trim().min(1).max(180),
        mimeType: z.string().trim().max(150),
        sizeBytes: z.number().int().min(1).max(MAX_CV_BYTES),
        sha256: sha256Hex,
      })
      .strict(),
    content: z.string(),
  })
  .strict();
export type ExtractionJobInput = z.infer<typeof extractionJobSchema>;
const fieldNames = Object.keys(extractedCandidateFieldsSchema.shape) as [
  Field,
  ...Field[],
];
export const aiReviewSchema = z
  .object({
    requestId: uuidSchema,
    decisions: z.partialRecord(
      z.enum(fieldNames),
      z.enum(["accepted", "rejected", "edited"]),
    ),
  })
  .strict();
export type AiReviewInput = z.infer<typeof aiReviewSchema>;

const notConfigured = () =>
  new ApiError(
    503,
    "ai_not_configured",
    "AI extraction is not configured. Enter details from each CV and verify them yourself.",
  );
const disclosureChanged = () =>
  new ApiError(
    409,
    "ai_disclosure_changed",
    "The AI service or its terms changed. Review the new details and allow AI suggestions again.",
  );
const digestMismatch = () =>
  new ApiError(
    400,
    "ai_digest_mismatch",
    "The CV content does not match its declared size or SHA-256 digest.",
  );
const mayHaveReached =
  "The CV may already have reached the AI service; trying again sends it again and counts against your team's AI limit.";
// Each provider outcome keeps its own status and code; none echoes provider text.
const failures: Record<ExtractionError, [number, string, string]> = {
  timed_out: [
    504,
    "ai_timed_out",
    `The AI service did not answer within ${AI_EXTRACTION_LIMITS.timeoutMs / 1000} seconds. No suggestions were added. ${mayHaveReached}`,
  ],
  rate_limited: [
    429,
    "ai_rate_limited",
    "The AI service is limiting requests right now. No suggestions were added; try again later or continue manually.",
  ],
  quota_exhausted: [
    429,
    "ai_quota_exhausted",
    "The AI service's usage quota is used up. No suggestions were added; continue manually.",
  ],
  provider_failed: [
    502,
    "ai_provider_failed",
    `The AI service could not complete the request. No suggestions were added. ${mayHaveReached}`,
  ],
  invalid_response: [
    502,
    "ai_invalid_response",
    "The AI service returned an answer that could not be used. No suggestions were added; continue manually.",
  ],
  cancelled: [
    409,
    "ai_cancelled",
    "The AI request was cancelled. No suggestions were added.",
  ],
};

function disclosureOf(provider: ExtractionProvider): ExtractionDisclosure {
  // A fixed key order, so the version changes exactly when a shown value changes.
  const shown = {
    provider: provider.name,
    model: provider.model,
    region: provider.region,
    retention: provider.retention,
    trainingUse: provider.trainingUse,
    costNote: provider.costNote,
    purpose: AI_EXTRACTION_PURPOSE,
    dataSent: AI_EXTRACTION_DATA_SENT,
    limits: AI_EXTRACTION_LIMITS_TEXT,
  };
  return {
    version: createHash("sha256").update(JSON.stringify(shown)).digest("hex"),
    ...shown,
  };
}
export function currentDisclosure(): ExtractionDisclosure | null {
  const provider = extractionProvider();
  return provider ? disclosureOf(provider) : null;
}

/** Serializes consent changes, budget checks and job starts within one team. */
async function lockAi(tx: TeamTx, p: Principal) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ai-extraction:${p.teamId}`}, 0))`,
  );
}
/** Append-only provenance; metadata never holds a file name, CV content or an extracted value. */
async function event(
  tx: TeamTx,
  p: Principal,
  action: string,
  summary: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(activity).values({
    id: randomUUID(),
    teamId: p.teamId,
    recordId: null,
    actorId: p.userId,
    actorType: p.authType,
    tokenId: p.tokenId ?? null,
    action,
    kind: KIND,
    summary,
    metadata,
    // Taken under the team lock, so event order is decision order.
    createdAt: sql`clock_timestamp()`,
  });
}

async function consentIn(
  tx: TeamTx,
  p: Principal,
  disclosure: ExtractionDisclosure | null,
): Promise<{ status: ConsentStatus; at: string | null }> {
  const [latest] = await tx
    .select({
      action: activity.action,
      metadata: activity.metadata,
      createdAt: activity.createdAt,
    })
    .from(activity)
    .where(
      and(
        eq(activity.teamId, p.teamId),
        eq(activity.actorId, p.userId),
        eq(activity.kind, KIND),
        inArray(activity.action, [GRANTED, WITHDRAWN]),
      ),
    )
    .orderBy(desc(activity.createdAt))
    .limit(1);
  if (!latest) return { status: "none", at: null };
  return {
    status:
      latest.action === WITHDRAWN
        ? "withdrawn"
        : disclosure && latest.metadata.disclosureVersion === disclosure.version
          ? "granted"
          : "outdated",
    at: latest.createdAt.toISOString(),
  };
}
/** The caller's latest consent decision in the selected team, against the current disclosure. */
export function consentStatus(p: Principal) {
  return withTeam(p, (tx) => consentIn(tx, p, currentDisclosure()));
}
/** What the consent endpoints return: availability, the disclosure and the caller's consent. */
export async function consentView(p: Principal) {
  const disclosure = currentDisclosure();
  return {
    available: disclosure !== null,
    disclosure,
    consent: await withTeam(p, (tx) => consentIn(tx, p, disclosure)),
  };
}

/** A grant needs a provider and the version shown; a withdrawal is always recorded. */
export async function recordConsent(
  p: Principal,
  decision: "grant" | "withdraw",
  disclosureVersion: string | null,
) {
  const disclosure = currentDisclosure();
  if (decision === "grant") {
    if (!disclosure) throw notConfigured();
    if (disclosureVersion !== disclosure.version) throw disclosureChanged();
  }
  await withTeam(p, async (tx) => {
    await lockAi(tx, p);
    if (decision === "grant" && disclosure)
      await event(tx, p, GRANTED, "Allowed AI suggestions from CVs", {
        disclosureVersion: disclosure.version,
        provider: disclosure.provider,
        model: disclosure.model,
      });
    else
      await event(tx, p, WITHDRAWN, "Withdrew consent to AI suggestions", {
        disclosureVersion,
      });
  });
}

function decodeBase64(content: string) {
  const bytes = Buffer.from(content, "base64");
  // Buffer decoding is lenient, so only canonical padded base64 is accepted.
  if (
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
    bytes.toString("base64") !== content
  )
    throw new ApiError(
      400,
      "invalid_input",
      "content: The CV content must be standard padded base64.",
    );
  return bytes;
}

/**
 * Sends one verified CV to the provider's adapter once, after the consent, request ID and team
 * budget checks commit a started event. The adapter receives only the bytes and MIME type, and
 * runs outside any transaction. The outcome is recorded; nothing is retried or saved to a record.
 */
export async function runExtractionJob(
  p: Principal,
  input: ExtractionJobInput,
  signal?: AbortSignal,
) {
  const provider = extractionProvider();
  if (!provider) throw notConfigured();
  const disclosure = disclosureOf(provider);
  const bytes = decodeBase64(input.content);
  if (bytes.length > AI_EXTRACTION_LIMITS.maxFileBytes)
    throw new ApiError(
      413,
      "ai_file_too_large",
      `AI suggestions accept CV files up to ${AI_EXTRACTION_LIMITS.maxFileBytes / 1024 / 1024} MiB.`,
    );
  if (bytes.length !== input.file.sizeBytes) throw digestMismatch();
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sourceSha256 !== input.file.sha256) throw digestMismatch();
  let mimeType: string;
  try {
    mimeType = validateCvMetadata(
      input.file.originalName,
      input.file.mimeType,
      bytes.length,
    ).mimeType;
    validateCvBytes(input.file.originalName, mimeType, bytes);
  } catch (error) {
    if (error instanceof CvValidationError)
      throw new ApiError(400, "INVALID_CV", error.message);
    throw error;
  }
  const { requestId } = input;
  const described = {
    sourceSha256,
    sizeBytes: bytes.length,
    mimeType,
    provider: disclosure.provider,
    model: disclosure.model,
  };
  await withTeam(p, async (tx) => {
    await lockAi(tx, p);
    if (input.disclosureVersion !== disclosure.version)
      throw disclosureChanged();
    if ((await consentIn(tx, p, disclosure)).status !== "granted")
      throw new ApiError(
        409,
        "ai_consent_required",
        "Allow AI suggestions before a CV is sent to the AI service.",
      );
    const startedEvents = and(
      eq(activity.teamId, p.teamId),
      eq(activity.kind, KIND),
      eq(activity.action, STARTED),
    );
    const [used] = await tx
      .select({ id: activity.id })
      .from(activity)
      .where(
        and(
          startedEvents,
          sql`${activity.metadata}->>'requestId' = ${requestId}`,
        ),
      )
      .limit(1);
    if (used)
      throw new ApiError(
        409,
        "ai_request_used",
        "This AI request was already sent. Start a new request to try again.",
      );
    const [{ total }] = await tx
      .select({ total: count() })
      .from(activity)
      .where(
        and(
          startedEvents,
          gt(activity.createdAt, sql`now() - interval '24 hours'`),
        ),
      );
    if (total >= AI_EXTRACTION_LIMITS.teamRequestsPer24Hours)
      throw new ApiError(
        429,
        "ai_budget_exhausted",
        `Your team has used its ${AI_EXTRACTION_LIMITS.teamRequestsPer24Hours} AI requests for the last 24 hours. Continue manually or try again later.`,
      );
    await event(tx, p, STARTED, "Sent a CV for AI suggestions", {
      requestId,
      ...described,
      disclosureVersion: disclosure.version,
    });
  });
  const result = await runCandidateExtraction(
    provider.adapter,
    { bytes, mimeType },
    { signal },
  );
  const extractedAt = new Date().toISOString();
  const outcome = result.ok ? "succeeded" : result.error;
  const suggestedFields = result.ok
    ? fieldNames.filter((field) => result.fields[field] != null)
    : [];
  await withTeam(p, (tx) =>
    event(
      tx,
      p,
      FINISHED,
      result.ok
        ? "AI suggestions received for review"
        : `AI suggestions failed: ${outcome.replace("_", " ")}`,
      { requestId, outcome, ...described, extractedAt, suggestedFields },
    ),
  );
  if (!result.ok) {
    const [status, code, message] = failures[result.error];
    throw new ApiError(status, code, message);
  }
  return {
    requestId,
    status: "succeeded" as const,
    suggestions: result.fields,
    provenance: {
      requestId,
      sourceSha256,
      provider: disclosure.provider,
      model: disclosure.model,
      extractedAt,
    },
  };
}

/**
 * The review provenance for a bulk item, checked inside the item's transaction: the caller's own
 * succeeded job for a file of the same size and type, with one decision per suggested field.
 */
export async function aiReviewEvidence(
  tx: TeamTx,
  p: Principal,
  review: AiReviewInput,
  file: { sizeBytes: number; mimeType: string },
) {
  const [finished] = await tx
    .select({ metadata: activity.metadata })
    .from(activity)
    .where(
      and(
        eq(activity.teamId, p.teamId),
        eq(activity.actorId, p.userId),
        eq(activity.kind, KIND),
        eq(activity.action, FINISHED),
        sql`${activity.metadata}->>'requestId' = ${review.requestId}`,
      ),
    )
    .limit(1);
  const job = finished?.metadata;
  if (
    !job ||
    job.outcome !== "succeeded" ||
    job.sizeBytes !== file.sizeBytes ||
    job.mimeType !== file.mimeType
  )
    throw new ApiError(
      400,
      "ai_review_invalid",
      "These AI suggestions do not belong to a completed AI request of yours for this CV. Remove the suggestions and review the draft manually.",
    );
  const suggested = new Set(job.suggestedFields as string[]);
  const decided = Object.keys(review.decisions);
  if (
    decided.length !== suggested.size ||
    decided.some((field) => !suggested.has(field))
  )
    throw new ApiError(
      400,
      "ai_review_incomplete",
      "Accept, reject or edit every AI suggestion before importing.",
    );
  return {
    requestId: review.requestId,
    sourceSha256: job.sourceSha256,
    provider: job.provider,
    model: job.model,
    extractedAt: job.extractedAt,
    decisions: review.decisions,
  };
}
