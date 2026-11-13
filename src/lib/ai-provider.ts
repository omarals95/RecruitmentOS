import type { CandidateExtractionAdapter } from "@/domain/cv-extraction";

export type ExtractionProvider = {
  name: string;
  model: string;
  region: string;
  retention: string;
  trainingUse: string;
  costNote: string;
  adapter: CandidateExtractionAdapter<{ bytes: Uint8Array; mimeType: string }>;
};

/**
 * No AI provider is approved yet (D-09), so this always returns null and AI extraction stays
 * unavailable. It reads no configuration and makes no network call; tests replace this module.
 */
export function extractionProvider(): ExtractionProvider | null {
  return null;
}
