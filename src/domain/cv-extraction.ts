import { z } from "zod";

const extractedText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();
const extractedTags = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .nullable()
  .optional();

// Omission means not supplied; null is an explicit unknown, never a value to save.
export const extractedCandidateFieldsSchema = z
  .object({
    name: extractedText(300),
    email: z.string().trim().email().max(320).nullable().optional(),
    phone: extractedText(100),
    jobTitle: extractedText(500),
    employer: extractedText(500),
    university: extractedText(500),
    degreeName: extractedText(500),
    major: extractedText(500),
    skills: extractedTags,
    certifications: extractedTags,
  })
  .strict();

export type ExtractedCandidateFields = z.infer<
  typeof extractedCandidateFieldsSchema
>;

export const AI_EXTRACTION_LIMITS = {
  maxFileBytes: 3 * 1024 * 1024,
  timeoutMs: 30_000,
  teamRequestsPer24Hours: 100,
};

// Every disclosure shows these texts; changing one changes the disclosure version.
export const AI_EXTRACTION_PURPOSE =
  "Suggest these 10 factual fields from this CV for you to accept, reject or edit before import: full name, email, phone, latest job title, latest employer, latest university, degree, major, skills and certifications. AI suggestions never rank, score, shortlist, reject or hire anyone.";
export const AI_EXTRACTION_DATA_SENT =
  "The selected CV file only, one file per request. No other candidate records, file names, account or team details are sent.";
export const AI_EXTRACTION_LIMITS_TEXT = `Files up to ${AI_EXTRACTION_LIMITS.maxFileBytes / 1024 / 1024} MiB. Up to ${AI_EXTRACTION_LIMITS.teamRequestsPer24Hours} requests per team in 24 hours; every request counts, including failed, cancelled or uncertain ones. Requests stop after ${AI_EXTRACTION_LIMITS.timeoutMs / 1000} seconds.`;

/** What a user is shown before consenting; version is a digest of every other field. */
export type ExtractionDisclosure = {
  version: string;
  provider: string;
  model: string;
  region: string;
  retention: string;
  trainingUse: string;
  costNote: string;
  purpose: string;
  dataSent: string;
  limits: string;
};

/** The only provider rejections that map to their own outcome; any other is provider_failed. */
export class ExtractionProviderError extends Error {
  constructor(public readonly code: "rate_limited" | "quota_exhausted") {
    super(code);
    this.name = "ExtractionProviderError";
  }
}

export type ExtractionError =
  | "provider_failed"
  | "invalid_response"
  | "timed_out"
  | "cancelled"
  | "rate_limited"
  | "quota_exhausted";

export interface CandidateExtractionAdapter<Input> {
  // Adapters must honor the signal; it cannot force a provider to stop.
  extract(input: Input, options: { signal: AbortSignal }): Promise<unknown>;
}

export async function runCandidateExtraction<Input>(
  adapter: CandidateExtractionAdapter<Input>,
  input: Input,
  options: { signal?: AbortSignal } = {},
): Promise<
  | { ok: true; fields: ExtractedCandidateFields }
  | { ok: false; error: ExtractionError }
> {
  if (options.signal?.aborted) return { ok: false, error: "cancelled" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let cancel: () => void;
  const stopped = new Promise<{ status: "timed_out" | "cancelled" }>(
    (resolve) => {
      cancel = () => {
        resolve({ status: "cancelled" });
        controller.abort();
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        resolve({ status: "timed_out" });
        controller.abort();
      }, AI_EXTRACTION_LIMITS.timeoutMs);
    },
  );
  try {
    const task = adapter.extract(input, { signal: controller.signal }).then(
      (output) => ({ status: "received" as const, output }),
      // The adapter's message is never returned; only its error code is.
      (error: unknown) => ({
        status:
          error instanceof ExtractionProviderError
            ? error.code
            : ("provider_failed" as const),
      }),
    );
    const result = await Promise.race([task, stopped]);
    if (result.status !== "received")
      return { ok: false, error: result.status };
    try {
      const parsed = extractedCandidateFieldsSchema.safeParse(result.output);
      // Tags are stored comma separated, so a tag holding a comma cannot be reviewed as one value.
      return parsed.success &&
        ![
          ...(parsed.data.skills ?? []),
          ...(parsed.data.certifications ?? []),
        ].some((tag) => tag.includes(","))
        ? { ok: true, fields: parsed.data }
        : { ok: false, error: "invalid_response" };
    } catch {
      return { ok: false, error: "invalid_response" };
    }
  } catch {
    return { ok: false, error: "provider_failed" };
  } finally {
    clearTimeout(timer!);
    options.signal?.removeEventListener("abort", cancel!);
  }
}
