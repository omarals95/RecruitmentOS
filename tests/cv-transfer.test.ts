import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  downloadVerifiedCv,
  saveCvBytes,
  sendCvBytes,
  storeCv,
  UPLOAD_LOCK_BUSY,
  UPLOAD_LOCK_UNSUPPORTED,
  withUploadLock,
  type UploadTicket,
} from "../src/components/cv-transfer";

// Fictional bytes and URLs only; no request leaves the fake fetch.
const blobUrl =
  "https://vercel.com/api/blob/?pathname=teams%2Ft%2Fcvs%2Fc%2Fu%2Ffictional.pdf&vercel-blob-signature=fictional_signature_0001";
const file = new Blob(["%PDF-1.7\nfictional"], { type: "application/pdf" });
function recorder(response = new Response(null, { status: 200 })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response;
  };
  return { calls, fetchImpl };
}

describe("sendCvBytes", () => {
  it("PUTs a blob-put-v1 file with only the returned headers and no credentials", async () => {
    const { calls, fetchImpl } = recorder();
    const upload: UploadTicket = {
      protocol: "blob-put-v1",
      method: "PUT",
      url: blobUrl,
      headers: { "content-type": "application/pdf" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      maxBytes: file.size,
    };
    const response = await sendCvBytes(upload, file, undefined, fetchImpl);
    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe(blobUrl);
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(file);
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-team-id")).toBe(false);
  });

  it("POSTs an s3-form-v1 form with the fields and then the file", async () => {
    const { calls, fetchImpl } = recorder(new Response(null, { status: 204 }));
    await sendCvBytes(
      {
        protocol: "s3-form-v1",
        method: "POST",
        url: "https://bucket.s3.eu-west-1.amazonaws.com/",
        fields: { key: "teams/t/cvs/fictional.pdf", policy: "fictional" },
        expiresAt: "2030-01-01T00:00:00.000Z",
        maxBytes: file.size,
      },
      file,
      undefined,
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    const { init } = calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toBeUndefined();
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
    expect(await (form.get("file") as Blob).text()).toBe("%PDF-1.7\nfictional");
  });

  it("throws before any request for a missing or unknown protocol", async () => {
    const { calls, fetchImpl } = recorder();
    for (const upload of [
      { url: "https://bucket.s3.amazonaws.com/", fields: {}, expiresAt: "x" },
      {
        protocol: "ftp-v1",
        method: "PUT",
        url: blobUrl,
        headers: {},
        expiresAt: "x",
        maxBytes: 1,
      },
      {
        protocol: "blob-put-v1",
        method: "POST",
        url: blobUrl,
        headers: {},
        expiresAt: "x",
        maxBytes: 1,
      },
      null,
    ])
      await expect(
        sendCvBytes(upload as UploadTicket, file, undefined, fetchImpl),
      ).rejects.toThrow(/upload method/);
    expect(calls).toHaveLength(0);
  });

  it("never puts the upload URL in an error message", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError(`fetch failed for ${blobUrl}`);
    };
    const error = await sendCvBytes(
      {
        protocol: "blob-put-v1",
        method: "PUT",
        url: blobUrl,
        headers: { "content-type": "application/pdf" },
        expiresAt: "2030-01-01T00:00:00.000Z",
        maxBytes: file.size,
      },
      file,
      undefined,
      failing,
    ).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("vercel.com");
    expect((error as Error).message).not.toContain("signature");
  });
});

describe("storeCv", () => {
  const blobTicket: UploadTicket = {
    protocol: "blob-put-v1",
    method: "PUT",
    url: blobUrl,
    headers: { "content-type": "application/pdf" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxBytes: file.size,
  };
  const s3Ticket: UploadTicket = {
    protocol: "s3-form-v1",
    method: "POST",
    url: "https://bucket.s3.eu-west-1.amazonaws.com/",
    fields: { key: "teams/t/cvs/fictional.pdf" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    maxBytes: file.size,
  };
  function completion(fails = false) {
    const state = { calls: 0 };
    const complete = async () => {
      state.calls++;
      if (fails) throw new Error("This upload was rejected or expired.");
      return { data: { status: "ready" } };
    };
    return { state, complete };
  }

  it("completes once after a Blob PUT that storage accepted", async () => {
    const { calls, fetchImpl } = recorder();
    const { state, complete } = completion();
    await storeCv(blobTicket, file, complete, undefined, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it("still completes after a refused Blob PUT, since an earlier PUT may have stored the bytes", async () => {
    const { calls, fetchImpl } = recorder(new Response(null, { status: 409 }));
    const { state, complete } = completion();
    await expect(
      storeCv(blobTicket, file, complete, undefined, fetchImpl),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it("reports the storage refusal when completion after a refused Blob PUT fails", async () => {
    const { fetchImpl } = recorder(new Response(null, { status: 409 }));
    const { state, complete } = completion(true);
    await expect(
      storeCv(blobTicket, file, complete, undefined, fetchImpl),
    ).rejects.toThrow(
      new Error("Private storage did not accept the CV (HTTP 409)."),
    );
    expect(state.calls).toBe(1);
  });

  it("refuses a refused S3 POST without completing", async () => {
    const { fetchImpl } = recorder(new Response(null, { status: 403 }));
    const { state, complete } = completion();
    await expect(
      storeCv(s3Ticket, file, complete, undefined, fetchImpl),
    ).rejects.toThrow(
      new Error("Private storage did not accept the CV (HTTP 403)."),
    );
    expect(state.calls).toBe(0);
  });
});

describe("downloadVerifiedCv client-side checks", () => {
  const uploadId = "00000000-0000-4000-8000-0000000000aa";
  const chunkSize = 4 * 1024 * 1024;
  const bytes = new Uint8Array(chunkSize + 1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 5) % 256;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    protocol: "blob-chunks-v1",
    uploadId,
    originalName: "fictional-cv.pdf",
    contentType: "application/pdf",
    sizeBytes: bytes.length,
    sha256: digest,
    chunkSize,
    chunkCount: 2,
  };
  type Chunk = {
    status?: number;
    headers: Record<string, string>;
    body: Uint8Array;
  };
  function chunk(index: number): Chunk {
    const offset = index * chunkSize;
    return {
      headers: {
        "X-CV-Upload-Id": uploadId,
        "X-CV-Chunk-Index": String(index),
        "X-CV-Chunk-Offset": String(offset),
        "X-CV-Size-Bytes": String(bytes.length),
        "X-CV-SHA256": digest,
      },
      body: bytes.slice(offset, offset + chunkSize),
    };
  }
  function server(
    options: {
      manifest?: Record<string, unknown>;
      chunks?: (index: number) => Chunk;
    } = {},
  ) {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/manifest"))
        return Response.json({ data: options.manifest ?? manifest });
      const index = Number(url.searchParams.get("index"));
      const reply = (options.chunks ?? chunk)(index);
      if (reply.status && reply.status >= 400)
        return Response.json(
          { error: { code: "CV_NOT_FOUND", message: "Not available." } },
          { status: reply.status },
        );
      return new Response(new Uint8Array(reply.body), {
        headers: reply.headers,
      });
    };
    return { requests, fetchImpl };
  }

  it("returns the verified bytes after fetching the manifest and each chunk with the team header", async () => {
    const { requests, fetchImpl } = server();
    const result = await downloadVerifiedCv("team-a", uploadId, fetchImpl);
    expect(Buffer.from(result.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(result.originalName).toBe("fictional-cv.pdf");
    expect(requests.map((request) => request.url)).toEqual([
      `/api/v1/cvs/${uploadId}/manifest`,
      `/api/v1/cvs/${uploadId}/chunks?index=0`,
      `/api/v1/cvs/${uploadId}/chunks?index=1`,
    ]);
    for (const { init } of requests) {
      expect(new Headers(init?.headers).get("x-team-id")).toBe("team-a");
      expect(init?.credentials).toBe("same-origin");
    }
  });

  const tampered: [string, Parameters<typeof server>[0]][] = [
    [
      "a chunk digest that disagrees with the manifest",
      {
        chunks: (index) => {
          const reply = chunk(index);
          if (index === 1) reply.headers["X-CV-SHA256"] = "0".repeat(64);
          return reply;
        },
      },
    ],
    [
      "a chunk upload id that disagrees with the manifest",
      {
        chunks: (index) => {
          const reply = chunk(index);
          reply.headers["X-CV-Upload-Id"] =
            "00000000-0000-4000-8000-0000000000bb";
          return reply;
        },
      },
    ],
    [
      "a chunk offset that disagrees with the manifest",
      {
        chunks: (index) => {
          const reply = chunk(index);
          if (index === 1) reply.headers["X-CV-Chunk-Offset"] = "1";
          return reply;
        },
      },
    ],
    [
      "a missing offset header",
      {
        chunks: (index) => {
          const reply = chunk(index);
          delete reply.headers["X-CV-Chunk-Offset"];
          return reply;
        },
      },
    ],
    [
      "a missing chunk",
      {
        chunks: (index) =>
          index === 1
            ? { status: 404, headers: {}, body: bytes }
            : chunk(index),
      },
    ],
    [
      "an inconsistent chunk count",
      { manifest: { ...manifest, chunkCount: 3 } },
    ],
    [
      "a different chunk size",
      { manifest: { ...manifest, chunkSize: 1024, chunkCount: 4097 } },
    ],
    [
      "altered bytes under consistent headers",
      {
        chunks: (index) => {
          const reply = chunk(index);
          if (index === 1) reply.body = reply.body.map((byte) => byte ^ 1);
          return reply;
        },
      },
    ],
  ];
  for (const [label, options] of tampered)
    it(`rejects ${label} and returns no bytes`, async () => {
      const { fetchImpl } = server(options);
      let returned: unknown;
      await expect(
        downloadVerifiedCv("team-a", uploadId, fetchImpl).then(
          (value) => (returned = value),
        ),
      ).rejects.toThrow();
      expect(returned).toBeUndefined();
    });
});

describe("saveCvBytes", () => {
  it("clicks an attached anchor and revokes the object URL only after the delay", async () => {
    const events: string[] = [];
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const scheduled: { callback: () => void; ms: number }[] = [];
    const anchor = {
      href: "",
      download: "",
      click: () => events.push("click"),
      remove: () => events.push("remove"),
    };
    const env: NonNullable<Parameters<typeof saveCvBytes>[2]> = {
      document: {
        createElement: ((tag: string) => {
          expect(tag).toBe("a");
          return anchor;
        }) as unknown as Document["createElement"],
        body: {
          append: (node: HTMLElement) => {
            expect(node).toBe(anchor);
            events.push("append");
          },
        },
      },
      URL: {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return "blob:http://localhost/fictional-1";
        },
        revokeObjectURL: (url: string) => {
          revoked.push(url);
        },
      },
      setTimeout: (callback: () => void, ms: number) =>
        scheduled.push({ callback, ms }),
    };
    const bytes = new TextEncoder().encode("%PDF-1.7\nfictional saved CV");
    saveCvBytes(bytes, "fictional-cv.pdf", env);
    expect(events).toEqual(["append", "click", "remove"]);
    expect(anchor.download).toBe("fictional-cv.pdf");
    expect(anchor.href).toBe("blob:http://localhost/fictional-1");
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("application/octet-stream");
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
    expect(revoked).toEqual([]);
    expect(scheduled.map(({ ms }) => ms)).toEqual([40_000]);
    scheduled[0].callback();
    expect(revoked).toEqual(["blob:http://localhost/fictional-1"]);
  });
});

describe("withUploadLock", () => {
  /** A fake Web Locks manager holding at most one named lock. */
  function fakeLocks(held = false) {
    const requests: { name: string; options: LockOptions }[] = [];
    const locks = {
      async request(
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown>,
      ) {
        requests.push({ name, options });
        return callback(held ? null : ({ name, mode: "exclusive" } as Lock));
      },
    } as Pick<LockManager, "request">;
    return { locks, requests };
  }

  it("runs the task under the shared lock when it is free", async () => {
    const { locks, requests } = fakeLocks();
    let ran = false;
    expect(
      await withUploadLock(async () => {
        ran = true;
      }, locks),
    ).toBe("");
    expect(ran).toBe(true);
    expect(requests).toEqual([
      { name: "recruitmentos-cv-upload", options: { ifAvailable: true } },
    ]);
  });

  it("starts nothing and explains when another upload holds the lock", async () => {
    const { locks } = fakeLocks(true);
    let ran = false;
    const message = await withUploadLock(async () => {
      ran = true;
    }, locks);
    expect(ran).toBe(false);
    expect(message).toBe(UPLOAD_LOCK_BUSY);
    expect(message).toMatch(/^Another CV upload is in progress/);
  });

  it("refuses without Web Locks instead of running unlocked", async () => {
    let ran = false;
    const message = await withUploadLock(async () => {
      ran = true;
    }, undefined);
    expect(ran).toBe(false);
    expect(message).toBe(UPLOAD_LOCK_UNSUPPORTED);
  });
});
