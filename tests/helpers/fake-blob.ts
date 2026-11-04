import { expect } from "vitest";
import { createBlobGateway, type BlobClient } from "@/lib/blob-storage";
import type { BlobTicketSigner } from "@/lib/blob-put-ticket";
import type { StorageBinding } from "@/lib/storage";

// Fictional data only: a synthetic signer and an in-memory object map.
export const blobBinding: StorageBinding = {
  provider: "blob",
  environment: "development",
  store: "store_fictional",
};
export const signingSecret = "fictional-client-signing-secret";

export type StoredObject = {
  bytes: Buffer;
  mimeType: string;
  reportedSize?: number;
  stall?: boolean;
};

/** Records whether the gateway closed a stream it opened but did not read to the end. */
function recordedStream(
  bytes: Buffer,
  stall: boolean | undefined,
  record: { closed: boolean },
): AsyncIterable<Uint8Array> {
  const generator = (async function* () {
    if (stall) await new Promise(() => {});
    for (let i = 0; i < bytes.length; i += 65536)
      yield new Uint8Array(bytes.subarray(i, i + 65536));
  })();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => generator.next(),
      return: () => {
        record.closed = true;
        return generator.return();
      },
    }),
  };
}

export function fakeBlob(binding: StorageBinding = blobBinding) {
  const objects = new Map<string, StoredObject>();
  const state = {
    signs: 0,
    reads: 0,
    signals: [] as AbortSignal[],
    failSigner: false,
    hangOpen: false,
    /** Every open resolves only after this delay, even when its read already gave up. */
    openDelayMs: 0,
    streams: [] as { pathname: string; closed: boolean }[],
  };
  let gate: { match: (pathname: string) => boolean; opened: Promise<void> } = {
    match: () => false,
    opened: Promise.resolve(),
  };
  /** Holds matching opens until the returned release is called. */
  function hold(match: (pathname: string) => boolean = () => true) {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    gate = { match, opened };
    return () => {
      gate = { match: () => false, opened: Promise.resolve() };
      release();
    };
  }
  const signer: BlobTicketSigner = {
    async issueSignedToken(options) {
      state.signs++;
      if (state.failSigner)
        throw new Error(`provider refused ${signingSecret}`);
      const scope = {
        storeId: binding.store.slice(6),
        pathname: options.pathname,
        operations: options.operations,
        validUntil: options.validUntil,
        maximumSizeInBytes: options.maximumSizeInBytes,
        allowedContentTypes: options.allowedContentTypes,
      };
      return {
        delegationToken: `${Buffer.from(JSON.stringify(scope)).toString("base64url")}.fictional_hmac`,
        clientSigningToken: signingSecret,
        validUntil: options.validUntil,
      };
    },
    async presignUrl(token, options) {
      const url = new URL("https://vercel.com/api/blob/");
      for (const [key, value] of Object.entries({
        pathname: options.pathname,
        "vercel-blob-delegation": token.delegationToken,
        "vercel-blob-signature": "fictional_signature_0001",
        "vercel-blob-allowed-content-types": options.allowedContentTypes[0],
        "vercel-blob-maximum-size-in-bytes": String(options.maximumSizeInBytes),
        "vercel-blob-add-random-suffix": "false",
        "vercel-blob-allow-overwrite": "false",
        "vercel-blob-valid-until": String(options.validUntil),
      }))
        url.searchParams.set(key, value);
      return { presignedUrl: url.toString() };
    },
  };
  const client: BlobClient = {
    signer,
    async open(pathname, { cache, signal }) {
      state.reads++;
      state.signals.push(signal);
      expect(cache).toBe("no-store");
      if (state.hangOpen) return new Promise(() => {});
      if (gate.match(pathname)) await gate.opened;
      if (state.openDelayMs)
        await new Promise((resolve) => setTimeout(resolve, state.openDelayMs));
      const object = objects.get(pathname);
      if (!object) return null;
      const record = { pathname, closed: false };
      state.streams.push(record);
      return {
        sizeBytes: object.reportedSize ?? object.bytes.length,
        mimeType: object.mimeType,
        stream: recordedStream(object.bytes, object.stall, record),
      };
    },
  };
  return {
    gateway: createBlobGateway(binding, client),
    client,
    objects,
    state,
    hold,
  };
}
