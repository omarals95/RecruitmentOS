/**
 * Live Vercel Blob provider verification for the PREVIEW store only.
 *
 * - Only the owner runs it, against the Preview Blob store with a Preview read-write token.
 *   Agents must never run it.
 * - It uploads only generated fictional bytes under live-verification/<random-uuid>/ and
 *   accepts no file path; it reads nothing from disk.
 * - It refuses to start without --confirm-live-preview-blob, a valid --store, a
 *   BLOB_READ_WRITE_TOKEN that is a read-write token for that same store, and a
 *   non-production VERCEL_ENV. Do not run it with DEBUG=blob: the SDK then logs responses.
 * - It never prints a token, signed URL, delegation token, signature or provider error.
 *   Each check prints one line: PASS|FAIL|OBSERVED <check-id> <short description>.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { del, get, list } from "@vercel/blob";
import {
  createBlobGateway,
  type BlobGateway,
} from "../src/lib/blob-storage.ts";
import { createVercelBlobClient } from "../src/lib/vercel-blob-client.ts";

const HELP = `Usage: BLOB_READ_WRITE_TOKEN=<Preview token> npx tsx scripts/blob-live-verify.ts --confirm-live-preview-blob --store store_<id>

Verifies no-overwrite, replay, constraints, late completion, multipart and deletion
behaviour of the PREVIEW Vercel Blob store only, using generated fictional bytes.
It reads no file from disk and deletes everything it created under its run prefix.
The token must be a read-write token for the --store store. Do not set DEBUG=blob.
Only the owner runs it. Agents must never run it.`;
const STORE_ID = /^store_[A-Za-z0-9]{1,128}$/;
const MIME = "application/pdf";
type Status = "PASS" | "FAIL" | "OBSERVED";

function refuse(reason: string): number {
  console.error(`Refused: ${reason} Nothing was contacted. See --help.`);
  return 2;
}

/** Fictional bytes only: a PDF signature followed by generated filler. */
function fictionalPdf(size: number, seed: number): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251;
  bytes.write("%PDF-1.7\n% fictional live verification only\n");
  return bytes;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function main(
  args = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        "confirm-live-preview-blob": { type: "boolean", default: false },
        store: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch {
    return refuse("Unknown or malformed arguments.");
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!values["confirm-live-preview-blob"])
    return refuse("--confirm-live-preview-blob is required.");
  const storeId = values.store;
  if (!storeId || !STORE_ID.test(storeId))
    return refuse("--store must be a Preview Blob store id (store_...).");
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token)
    return refuse(
      "BLOB_READ_WRITE_TOKEN (Preview) must be set in the environment.",
    );
  if (env.VERCEL_ENV === "production")
    return refuse(
      "VERCEL_ENV is production; this script targets Preview only.",
    );
  // The SDK reaches the store the token names; --store must be that store.
  if (
    !token.startsWith("vercel_blob_rw_") ||
    token.split("_")[3] !== storeId.slice("store_".length)
  )
    return refuse(
      "BLOB_READ_WRITE_TOKEN must be a read-write token for the --store store.",
    );

  let failures = 0;
  const report = (status: Status, id: string, description: string) => {
    if (status === "FAIL") failures++;
    console.log(`${status} ${id} ${description}`);
  };
  let gateway: BlobGateway;
  try {
    gateway = createBlobGateway(
      { provider: "blob", environment: "preview", store: storeId },
      createVercelBlobClient({ storeId, token }),
    );
  } catch {
    report("FAIL", "setup", "the Blob client could not be configured");
    return 1;
  }

  const prefix = `live-verification/${randomUUID()}/`;
  const reservation = (name: string, sizeBytes: number, validMs = 240_000) => ({
    teamId: "live-verification",
    objectKey: `${prefix}${name}.pdf`,
    originalName: `${name}.pdf`,
    mimeType: MIME,
    sizeBytes,
    expiresAt: new Date(Date.now() + validMs),
  });
  /** Status code, or 0 for a transport failure. Never surfaces the URL or error text. */
  const send = async (
    url: string,
    body: BodyInit,
    headers: Record<string, string> = { "content-type": MIME },
    streamed = false,
  ): Promise<number> => {
    try {
      const response = await fetch(url, {
        method: "PUT",
        body,
        headers,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
        // A streamed request body needs half duplex in Node fetch.
        ...(streamed ? { duplex: "half" } : {}),
      } as RequestInit);
      await response.body?.cancel().catch(() => {});
      return response.status;
    } catch {
      return 0;
    }
  };
  const accepted = (status: number) => status >= 200 && status < 300;
  const stored = async (pathname: string) => {
    const result = await list({ prefix: pathname, token });
    return result.blobs.find((blob) => blob.pathname === pathname) ?? null;
  };
  const run = async (id: string, check: () => Promise<void>) => {
    try {
      await check();
    } catch {
      report("FAIL", id, "the check could not complete");
    }
  };

  try {
    await run("headers", async () => {
      const bytes = fictionalPdf(2000, 1);
      const input = reservation("headers", bytes.length);
      const ticket = await gateway.issuePutTicket(input);
      const status = await send(ticket.url, bytes);
      if (!accepted(status)) {
        report(
          "FAIL",
          "headers",
          `a PUT with only content-type was refused (HTTP ${status})`,
        );
        const retry = reservation("headers-access", bytes.length);
        const second = await gateway.issuePutTicket(retry);
        const withAccess = await send(second.url, bytes, {
          "content-type": MIME,
          "x-vercel-blob-access": "private",
        });
        report(
          "OBSERVED",
          "headers",
          accepted(withAccess)
            ? "adding x-vercel-blob-access: private made the PUT succeed, so it is required"
            : `adding x-vercel-blob-access: private did not help (HTTP ${withAccess})`,
        );
        return;
      }
      report("PASS", "headers", "a PUT with only content-type was accepted");
      const inspected = await gateway.inspectUpload(input);
      const reference = {
        teamId: input.teamId,
        objectKey: input.objectKey,
        mimeType: MIME,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      };
      const slice = await gateway.readVerifiedSlice(reference, 0, bytes.length);
      report(
        inspected?.sha256 === sha256(bytes) && slice?.equals(bytes)
          ? "PASS"
          : "FAIL",
        "headers",
        "the gateway inspected and read back the verified fictional bytes",
      );
    });

    await run("no-overwrite", async () => {
      const first = fictionalPdf(2000, 2);
      const second = fictionalPdf(2000, 3);
      const input = reservation("no-overwrite", first.length);
      const ticket = await gateway.issuePutTicket(input);
      if (!accepted(await send(ticket.url, first))) {
        report("FAIL", "no-overwrite", "the first PUT was refused");
        return;
      }
      const again = await gateway.issuePutTicket(input);
      const status = await send(again.url, second);
      report(
        accepted(status) ? "FAIL" : "PASS",
        "no-overwrite",
        accepted(status)
          ? "a second ticket overwrote the existing object"
          : `a second ticket for the same pathname was refused (HTTP ${status})`,
      );
      const inspected = await gateway.inspectUpload(input);
      report(
        inspected?.sha256 === sha256(first) ? "PASS" : "FAIL",
        "no-overwrite",
        "the gateway still verifies the first bytes' digest",
      );
    });

    await run("replay", async () => {
      const first = fictionalPdf(2000, 4);
      const input = reservation("replay", first.length);
      const ticket = await gateway.issuePutTicket(input);
      if (!accepted(await send(ticket.url, first))) {
        report("FAIL", "replay", "the first PUT was refused");
        return;
      }
      const status = await send(ticket.url, fictionalPdf(2000, 5));
      report(
        accepted(status) ? "FAIL" : "PASS",
        "replay",
        accepted(status)
          ? "re-sending the same signed URL was accepted"
          : `re-sending the same signed URL was refused (HTTP ${status})`,
      );
      const inspected = await gateway.inspectUpload(input);
      report(
        inspected?.sha256 === sha256(first) ? "PASS" : "FAIL",
        "replay",
        "the stored object still holds the first bytes",
      );
    });

    await run("constraints", async () => {
      const bytes = fictionalPdf(2000, 6);
      const wrongType = reservation("constraints-type", bytes.length);
      const typeTicket = await gateway.issuePutTicket(wrongType);
      const typeStatus = await send(typeTicket.url, bytes, {
        "content-type": "image/png",
      });
      const typeStored = await stored(wrongType.objectKey);
      report(
        !accepted(typeStatus) && !typeStored ? "PASS" : "FAIL",
        "constraints",
        `a wrong content type was ${accepted(typeStatus) ? "accepted" : `refused (HTTP ${typeStatus})`} and ${typeStored ? "an object exists" : "no object exists"}`,
      );
      const oversize = reservation("constraints-size", bytes.length);
      const sizeTicket = await gateway.issuePutTicket(oversize);
      const sizeStatus = await send(
        sizeTicket.url,
        fictionalPdf(bytes.length + 1, 7),
      );
      const sizeStored = await stored(oversize.objectKey);
      report(
        !accepted(sizeStatus) && !sizeStored ? "PASS" : "FAIL",
        "constraints",
        `a body over maximumSizeInBytes was ${accepted(sizeStatus) ? "accepted" : `refused (HTTP ${sizeStatus})`} and ${sizeStored ? "an object exists" : "no object exists"}`,
      );
    });

    await run("late-completion", async () => {
      const bytes = fictionalPdf(64 * 1024, 8);
      const validMs = 20_000;
      const slow = reservation("late-completion", bytes.length, validMs);
      const after = reservation("late-start", bytes.length, validMs);
      const [slowTicket, afterTicket] = await Promise.all([
        gateway.issuePutTicket(slow),
        gateway.issuePutTicket(after),
      ]);
      const finishAt = slowTicket.expiresAt + 5_000;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(bytes.subarray(0, 1024)));
          await sleep(Math.max(0, finishAt - Date.now()));
          controller.enqueue(new Uint8Array(bytes.subarray(1024)));
          controller.close();
        },
      });
      const status = await send(slowTicket.url, body, undefined, true);
      const slowStored = await stored(slow.objectKey);
      report(
        "OBSERVED",
        "late-completion",
        `a PUT started before expiry and finished after it was ${accepted(status) ? "accepted" : `refused (HTTP ${status})`}; ${slowStored ? "an object exists" : "no object exists"}`,
      );
      await sleep(Math.max(0, afterTicket.expiresAt + 1_000 - Date.now()));
      const lateStatus = await send(afterTicket.url, bytes);
      report(
        accepted(lateStatus) ? "FAIL" : "PASS",
        "late-completion",
        accepted(lateStatus)
          ? "a PUT started after expiry was accepted"
          : `a PUT started after expiry was refused (HTTP ${lateStatus})`,
      );
    });

    await run("multipart", async () => {
      const limit = 2000;
      const input = reservation("multipart", limit);
      const ticket = await gateway.issuePutTicket(input);
      const mpu = new URL(ticket.url);
      mpu.pathname = "/api/blob/mpu";
      /** The SDK's multipart wire format, signed only by the PUT ticket's query. */
      const post = async (headers: Record<string, string>, body?: BodyInit) => {
        try {
          const response = await fetch(mpu, {
            method: "POST",
            body,
            headers,
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(60_000),
          });
          const json = response.ok
            ? ((await response.json().catch(() => null)) as Record<
                string,
                unknown
              > | null)
            : (await response.body?.cancel().catch(() => {}), null);
          return { status: response.status, json };
        } catch {
          return { status: 0, json: null };
        }
      };
      const create = await post({
        "content-type": MIME,
        "x-mpu-action": "create",
      });
      const key = create.json?.key;
      const uploadId = create.json?.uploadId;
      if (typeof key !== "string" || typeof uploadId !== "string")
        report(
          "OBSERVED",
          "multipart",
          `a multipart create with the PUT ticket was refused (HTTP ${create.status})`,
        );
      else {
        report(
          "OBSERVED",
          "multipart",
          "a multipart create with the PUT ticket was accepted",
        );
        const ids = {
          "x-mpu-key": encodeURIComponent(key),
          "x-mpu-upload-id": uploadId,
        };
        const part = await post(
          { ...ids, "x-mpu-action": "upload", "x-mpu-part-number": "1" },
          fictionalPdf(limit * 3, 9),
        );
        const etag = part.json?.etag;
        report(
          "OBSERVED",
          "multipart",
          `an oversized part was ${typeof etag === "string" ? "accepted" : `refused (HTTP ${part.status})`}`,
        );
        if (typeof etag === "string") {
          const complete = await post(
            {
              ...ids,
              "content-type": "application/json",
              "x-mpu-action": "complete",
            },
            JSON.stringify([{ etag, partNumber: 1 }]),
          );
          report(
            "OBSERVED",
            "multipart",
            `completing the oversized upload was ${complete.status >= 200 && complete.status < 300 ? "accepted" : `refused (HTTP ${complete.status})`}`,
          );
        }
      }
      const object = await stored(input.objectKey);
      report(
        object && object.size > limit ? "FAIL" : "PASS",
        "multipart",
        object && object.size > limit
          ? "multipart bypassed the size limit"
          : "the size limit held",
      );
      report(
        "OBSERVED",
        "multipart",
        `${object ? "an object remains" : "no object remains"}; uncompleted parts cannot be listed through the API`,
      );
    });

    await run("deletion", async () => {
      const bytes = fictionalPdf(2000, 10);
      const input = reservation("deletion", bytes.length);
      const ticket = await gateway.issuePutTicket(input);
      if (!accepted(await send(ticket.url, bytes))) {
        report("FAIL", "deletion", "the first PUT was refused");
        return;
      }
      await del(input.objectKey, { token });
      const read = await get(input.objectKey, {
        access: "private",
        useCache: false,
        token,
      });
      if (read?.stream) await read.stream.cancel().catch(() => {});
      report(
        read === null ? "PASS" : "FAIL",
        "deletion",
        "a deleted object reads as missing",
      );
      const status = await send(ticket.url, bytes);
      report(
        "OBSERVED",
        "deletion",
        `retrying the still-valid original ticket ${accepted(status) ? "recreated the object" : `was refused (HTTP ${status})`}`,
      );
    });
  } finally {
    try {
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, token });
        if (page.blobs.length)
          await del(
            page.blobs.map((blob) => blob.pathname),
            { token },
          );
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      const left = await list({ prefix, token });
      report(
        left.blobs.length ? "FAIL" : "PASS",
        "cleanup",
        left.blobs.length
          ? `${left.blobs.length} objects remain under the run prefix`
          : "no object remains under the run prefix",
      );
    } catch {
      report("FAIL", "cleanup", "the run prefix could not be cleaned up");
    }
  }
  return failures ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("Live Blob verification stopped unexpectedly.");
      process.exitCode = 1;
    });
