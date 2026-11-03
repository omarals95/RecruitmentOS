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
  extract(input: Input): Promise<unknown>;
}

export async function runCandidateExtraction<Input>(
  adapter: CandidateExtractionAdapter<Input>,
  input: Input,
): Promise<
  | { ok: true; fields: ExtractedCandidateFields }
  | { ok: false; error: "provider_failed" | "invalid_response" }
> {
  let output: unknown;
  try {
    output = await adapter.extract(input);
  } catch {
    return { ok: false, error: "provider_failed" };
  }
  try {
    const parsed = extractedCandidateFieldsSchema.safeParse(output);
    return parsed.success
      ? { ok: true, fields: parsed.data }
      : { ok: false, error: "invalid_response" };
  } catch {
    return { ok: false, error: "invalid_response" };
  }
}
