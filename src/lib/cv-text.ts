import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** Server-side text of verified CV bytes. Nothing extracted is stored, cached, logged or written. */
export const MAX_CV_TEXT_CHARACTERS = 30_000;
export const MAX_CV_EXTRACTION_MS = 10_000;
/**
 * The memory one extraction may hold: its heap plus its array buffers, where PDF.js keeps decoded
 * streams. resourceLimits caps only the heap, so the parent samples both and ends the worker past
 * the cap. At most two extractions run at once in a process. Tests may lower the cap.
 */
export const cvExtractionLimits = {
  memoryBytes: 512 * 1024 * 1024,
  sampleMs: 10,
};
const MAX_CONCURRENT_EXTRACTIONS = 2;
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

let running = 0;
const waiting: (() => void)[] = [];
/** Waits for one of the process's extraction slots until the deadline; null when none came free. */
async function extractionSlot(deadline: number) {
  while (running >= MAX_CONCURRENT_EXTRACTIONS) {
    const freed = await new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(wake), 1);
        resolve(false);
      }, deadline - Date.now());
      waiting.push(wake);
    });
    if (!freed) return null;
  }
  running++;
  return () => {
    running--;
    waiting.shift()?.();
  };
}

/**
 * Extracts plain text in a worker thread, ended at the deadline or once its heap and array buffers
 * pass cvExtractionLimits.memoryBytes. Resolves null for a timeout, too much memory, a parse error,
 * an encrypted file, empty text or an unparsed type; text past maxCharacters is cut and marked
 * truncated. The worker's output streams are never forwarded.
 */
export async function extractCvText(
  mimeType: string,
  bytes: Buffer,
  timeoutMs: number = MAX_CV_EXTRACTION_MS,
  maxCharacters: number = MAX_CV_TEXT_CHARACTERS,
): Promise<{ text: string; truncated: boolean } | null> {
  const kind = PARSED[mimeType];
  const deadline = Date.now() + Math.min(timeoutMs, MAX_CV_EXTRACTION_MS);
  if (!kind || timeoutMs < 1) return null;
  const release = await extractionSlot(deadline);
  if (!release) return null;
  try {
    return await new Promise((resolve) => {
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
        clearInterval(watch);
        // Termination also stops synchronous parsing at its next interrupt check. The slot is
        // released only once the worker has exited and its memory is gone.
        void worker
          .terminate()
          .catch(() => {})
          .finally(() => resolve(result));
      };
      const timer = setTimeout(
        () => finish(null),
        Math.max(0, deadline - Date.now()),
      );
      // The statistics are answered while the worker runs, including inside a long decode.
      let sampling = false;
      const watch = setInterval(() => {
        if (sampling) return;
        sampling = true;
        worker
          .getHeapStatistics()
          .then(
            (heap) => {
              if (
                heap.used_heap_size + heap.external_memory >
                cvExtractionLimits.memoryBytes
              )
                finish(null);
            },
            () => {},
          )
          .finally(() => {
            sampling = false;
          });
      }, cvExtractionLimits.sampleMs);
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
  } finally {
    release();
  }
}
