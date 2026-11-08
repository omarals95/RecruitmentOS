// Runs in a worker thread with its own memory limit; the parent terminates it at the deadline.
// It receives one verified PDF or DOCX buffer, returns plain text or null, and writes nothing.
// Plain JavaScript and not bundled: the server trace includes it and the two parsers as they are.
import { parentPort, workerData } from "node:worker_threads";

const { kind, bytes, maxCharacters } = workerData;

async function extract() {
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // No font loading, WebAssembly decoders or log output; text extraction needs none of them.
    // This PDF.js build has no eval path, and with data given it fetches nothing.
    const pdf = await getDocumentProxy(bytes, {
      disableFontFace: true,
      useSystemFonts: false,
      useWasm: false,
      verbosity: 0,
    });
    return (await extractText(pdf, { mergePages: true })).text;
  }
  const { default: mammoth } = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
}

extract().then(
  (text) => {
    // Only the capped text crosses back; the flag marks a cut.
    const characters = Array.from(text.trim());
    parentPort.postMessage({
      text: characters.slice(0, maxCharacters).join(""),
      truncated: characters.length > maxCharacters,
    });
  },
  () => parentPort.postMessage({ text: null }),
);
