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
  | {
      ok: false;
      error: "provider_failed" | "invalid_response" | "timed_out" | "cancelled";
    }
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
      }, 30_000);
    },
  );
  try {
    const task = adapter.extract(input, { signal: controller.signal }).then(
      (output) => ({ status: "received" as const, output }),
      () => ({ status: "provider_failed" as const }),
    );
    const result = await Promise.race([task, stopped]);
    if (result.status !== "received")
      return { ok: false, error: result.status };
    try {
      const parsed = extractedCandidateFieldsSchema.safeParse(result.output);
      return parsed.success
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
