import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** Server-side text of verified CV bytes. Nothing extracted is stored, cached, logged or written. */
export const MAX_CV_TEXT_CHARACTERS = 30_000;
export const MAX_CV_EXTRACTION_MS = 10_000;
// Unbundled on purpose and resolved from the project root, which the server trace keeps.
const WORKER_PATH = join(process.cwd(), "src", "lib", "cv-text-worker.mjs");
const PARSED: Record<string, "pdf" | "docx"> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
};

/** Only PDF and DOCX are parsed; DOC, Pages and images are never parsed or OCRed. */
export function hasReadableText(mimeType: string): boolean {
  return mimeType in PARSED;
}

/**
 * Extracts plain text in a worker thread under a memory limit, terminated at the deadline. Resolves
 * null for a timeout, a parse error, an encrypted file, empty text or an unparsed type; text past
 * maxCharacters is cut and marked truncated. The worker's output streams are never forwarded.
 */
export function extractCvText(
  mimeType: string,
  bytes: Buffer,
  timeoutMs: number = MAX_CV_EXTRACTION_MS,
  maxCharacters: number = MAX_CV_TEXT_CHARACTERS,
): Promise<{ text: string; truncated: boolean } | null> {
  const kind = PARSED[mimeType];
  if (!kind || timeoutMs < 1) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_PATH, {
      workerData: { kind, bytes: new Uint8Array(bytes), maxCharacters },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (result: { text: string; truncated: boolean } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(null),
      Math.min(timeoutMs, MAX_CV_EXTRACTION_MS),
    );
    worker.once(
      "message",
      (message: { text: string | null; truncated?: boolean }) =>
        finish(
          typeof message?.text === "string" && message.text
            ? { text: message.text, truncated: message.truncated === true }
            : null,
        ),
    );
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}
