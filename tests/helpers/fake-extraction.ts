import { ExtractionProviderError } from "@/domain/cv-extraction";
import type { ExtractionProvider } from "@/lib/ai-provider";

type Input = { bytes: Uint8Array; mimeType: string };
export type FakeBehaviour =
  | { kind: "return"; output: unknown }
  | { kind: "provider-error"; code: "rate_limited" | "quota_exhausted" }
  | { kind: "error" }
  | { kind: "hang" };

/**
 * A fictional extraction provider for tests only. Its adapter records every input it receives
 * and answers as told: a given output, a provider error, a plain error, or no answer until aborted.
 */
export function createFakeExtraction() {
  const inputs: Input[] = [];
  const state = {
    behaviour: { kind: "return", output: {} } as FakeBehaviour,
  };
  const provider: ExtractionProvider = {
    name: "Fictional Extraction Service",
    model: "fictional-model-1",
    region: "Fictional region (test only)",
    retention: "Fictional: deleted after 30 days",
    trainingUse: "Fictional: not used for training",
    costNote: "Fictional: no charge in tests",
    adapter: {
      extract(input, { signal }) {
        inputs.push(input);
        const behaviour = state.behaviour;
        if (behaviour.kind === "return")
          return Promise.resolve(behaviour.output);
        if (behaviour.kind === "provider-error")
          return Promise.reject(new ExtractionProviderError(behaviour.code));
        if (behaviour.kind === "error")
          return Promise.reject(new Error("fictional provider failure"));
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("fictional abort")),
          ),
        );
      },
    },
  };
  return {
    provider,
    inputs,
    get calls() {
      return inputs.length;
    },
    answer(behaviour: FakeBehaviour) {
      state.behaviour = behaviour;
    },
    reset() {
      inputs.length = 0;
      state.behaviour = { kind: "return", output: {} };
    },
  };
}
