import { randomUUID } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DEC-07: CVs are never rendered inline. Route handlers get the fake gateway through the storage module.
const configured = vi.hoisted(() => ({
  current: undefined as undefined | { binding: unknown; gateway: unknown },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    storageConfigured: () => true,
    resolveStorageBinding: () => {
      if (!configured.current)
        throw new original.StorageConfigurationError("No fake storage.");
      return configured.current.binding;
    },
    getStorage: async () => configured.current?.gateway,
  };
});

import { createToken } from "@/lib/api-tokens";
import { beginCvUpload, completeCvUpload } from "@/lib/cvs";
import {
  beginRecordFileUpload,
  completeRecordFileUpload,
} from "@/lib/record-files";
import { createRecord, updateRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import { attachmentDisposition } from "@/lib/storage";
import { GET as chunkRoute } from "@/app/api/v1/cvs/[id]/chunks/route";
import { GET as fileChunkRoute } from "@/app/api/v1/record-files/[id]/chunks/route";
import { createTestDb, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { blobBinding, fakeBlob } from "./helpers/fake-blob";
import {
  customField,
  insertKindSchema,
  kindBody,
} from "./helpers/kind-schemas";

/**
 * Every CV and record file route, keyed by its path under src/app/api/v1. A new route.ts fails the
 * first test until it is classified here; only "bytes" routes may return file content.
 */
const CV_ROUTES: Record<string, "bytes" | "json"> = {
  "candidates/[id]/cvs/route.ts": "json",
  "candidates/[id]/cvs/uploads/route.ts": "json",
  "cvs/[id]/chunks/route.ts": "bytes",
  "cvs/[id]/download/route.ts": "json",
  "cvs/[id]/manifest/route.ts": "json",
  "cvs/bulk-batches/[batchId]/items/[itemId]/route.ts": "json",
  "cvs/bulk-batches/[batchId]/items/[itemId]/upload/route.ts": "json",
  "cvs/bulk-batches/[batchId]/route.ts": "json",
  "cvs/bulk-batches/route.ts": "json",
  "cvs/bulk-capabilities/route.ts": "json",
  "cvs/storage-reconciliation/route.ts": "json",
  "cvs/uploads/[id]/complete/route.ts": "json",
  // File fields (R2b-06) go through the same attachment-only download.
  "record-files/[id]/chunks/route.ts": "bytes",
  "record-files/[id]/manifest/route.ts": "json",
  "record-files/uploads/[id]/complete/route.ts": "json",
  "record-files/uploads/route.ts": "json",
};
const API_ROOT = "src/app/api/v1/";
const discovered = [
  ...globSync(`${API_ROOT}cvs/**/route.ts`),
  ...globSync(`${API_ROOT}candidates/*/cvs/**/route.ts`),
  ...globSync(`${API_ROOT}record-files/**/route.ts`),
]
  .map((path) => path.replaceAll("\\", "/").slice(API_ROOT.length))
  .sort();

/** A stored-format-valid DOCX: a minimal ZIP holding a word-processing package. */
function docx(): Buffer {
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml": "<w:document>fictional</w:document>",
  };
  const chunks: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name),
      data = Buffer.from(text),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    chunks.push(local, n, data);
    directory.push(central, n);
    offset += local.length + n.length + data.length;
  }
  const dir = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}

describe("CV routes never return inline content (DEC-07)", () => {
  it("classifies every CV and record file route.ts on disk, with the two chunks routes as the only ones returning bytes", () => {
    expect(discovered).toEqual(Object.keys(CV_ROUTES).sort());
    expect(
      discovered.filter((path) => path.startsWith("record-files/")),
    ).toEqual([
      "record-files/[id]/chunks/route.ts",
      "record-files/[id]/manifest/route.ts",
      "record-files/uploads/[id]/complete/route.ts",
      "record-files/uploads/route.ts",
    ]);
    expect(
      Object.entries(CV_ROUTES)
        .filter(([, kind]) => kind === "bytes")
        .map(([path]) => path),
    ).toEqual([
      "cvs/[id]/chunks/route.ts",
      "record-files/[id]/chunks/route.ts",
    ]);
  });

  for (const [path, kind] of Object.entries(CV_ROUTES))
    if (kind === "json")
      it(`answers ${path} only with application/json`, async () => {
        // Bytes need a Response built by hand; JSON routes answer only through json() and runApi.
        const source = readFileSync(API_ROOT + path, "utf8");
        expect(source).not.toMatch(/\bResponse\s*\(/);
        expect(source).not.toMatch(/\bnew\s+Response\b/);
        expect(source).toMatch(/\brunApi\b/);
        const route = (await import(
          /* @vite-ignore */ `../${API_ROOT}${path}`
        )) as Record<
          string,
          (request: Request, context: unknown) => Promise<Response>
        >;
        const handlers = Object.entries(route).filter(([name]) =>
          ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(name),
        );
        expect(handlers.length).toBeGreaterThan(0);
        for (const [method, handler] of handlers) {
          const response = await handler(
            new Request(`http://localhost:3000/api/v1/${path}`, {
              method,
              headers: { origin: "http://localhost:3000" },
            }),
            { params: Promise.resolve({ id: randomUUID() }) },
          );
          expect(response.headers.get("content-type"), method).toMatch(
            /^application\/json\b/,
          );
          expect(response.headers.get("content-disposition")).toBeNull();
        }
      });

  it("never produces an inline disposition for any file name", () => {
    for (const name of [
      "inline.pdf",
      "inline",
      "cv;inline.pdf",
      'cv"; inline; filename="x.pdf',
      "cv.pdf; inline",
      "INLINE.PDF",
      "résumé inline.docx",
      "cv\r\nContent-Disposition: inline.pdf",
      "",
      "‮inline.pdf",
    ]) {
      const value = attachmentDisposition(name);
      expect(value, name).toMatch(
        /^attachment; filename="[^";\\]*"; filename\*=UTF-8''[^;\s"]*$/,
      );
      expect(value.split(";")[0], name).toBe("attachment");
    }
  });

  it("signs legacy S3 downloads as attachment octet-stream overrides", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/storage")>("@/lib/storage");
    for (const [key, value] of Object.entries({
      CV_STORAGE_PROVIDER: "s3",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "fictional-inline-test",
      AWS_ROLE_ARN: undefined,
      VERCEL: undefined,
      AWS_ACCESS_KEY_ID: "FAKE_TEST_ONLY_ACCESS",
      AWS_SECRET_ACCESS_KEY: "fake-test-only-secret-not-a-real-key",
      AWS_SESSION_TOKEN: undefined,
    }))
      vi.stubEnv(key, value);
    try {
      const storage = await actual.getStorage();
      if ("readVerifiedSlice" in storage) throw new Error("Expected S3.");
      // Signing with fictional credentials is local; nothing is sent to S3.
      const url = new URL(
        await storage.signDownload(
          "teams/fictional/cvs/inline.pdf",
          "fixed-v1",
          "inline.pdf",
        ),
      );
      expect(url.searchParams.get("response-content-type")).toBe(
        "application/octet-stream",
      );
      expect(url.searchParams.get("response-content-disposition")).toMatch(
        /^attachment; /,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const FILES = [
    [
      "fictional-cv.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7\nfictional inline check\n"),
    ],
    [
      "fictional-cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      docx(),
    ],
    [
      "fictional-cv.png",
      "image/png",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
    ],
  ] as const;
  describe("the chunks route", () => {
    let fixture: Awaited<ReturnType<typeof createTestDb>>;
    let owner: Principal;
    let candidateId = "";
    let token = "";
    beforeAll(async () => {
      stubLocalAuthReadiness();
      fixture = await createTestDb();
      owner = await seedIdentity(fixture.db, {
        userId: "inline-owner",
        teamId: "inline-team",
      });
      candidateId = (
        await createRecord(owner, "candidates", {
          data: { name: "Fictional Inline Candidate" },
        })
      ).id;
      token = (
        await createToken(owner, {
          name: "Fictional inline test",
          scopes: ["candidates:read", "cvs:read"],
        })
      ).token;
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await fixture?.close();
    });

    for (const [originalName, mimeType, bytes] of FILES)
      it(`sends a ${mimeType} CV as an octet-stream attachment, never as its stored type`, async () => {
        const fake = fakeBlob();
        configured.current = { binding: blobBinding, gateway: fake.gateway };
        const reserved = await beginCvUpload(
          owner,
          candidateId,
          {
            originalName,
            mimeType,
            sizeBytes: bytes.length,
            clientUploadId: randomUUID(),
          },
          fake.gateway,
        );
        const [row] = (
          await fixture.client.query<{ object_key: string }>(
            "SELECT object_key FROM app.uploads WHERE id=$1",
            [reserved.data.id],
          )
        ).rows;
        fake.objects.set(row.object_key, {
          bytes: Buffer.from(bytes),
          mimeType,
        });
        const ready = await completeCvUpload(
          owner,
          reserved.data.id,
          fake.gateway,
        );
        expect(ready.status).toBe("ready");
        const response = await chunkRoute(
          new Request(
            `http://localhost:3000/api/v1/cvs/${ready.id}/chunks?index=0`,
            { headers: { authorization: `Bearer ${token}` } },
          ),
          { params: Promise.resolve({ id: ready.id }) },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        expect(response.headers.get("content-type")).not.toContain(mimeType);
        expect(response.headers.get("content-disposition")).toMatch(
          /^attachment;/,
        );
        expect(response.headers.get("content-disposition")).not.toMatch(
          /inline/i,
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          Buffer.from(bytes),
        );
      });

    it("sends a record file of a file field as an octet-stream attachment, never as its stored type", async () => {
      const field = customField("Fictional inline certificate", "file");
      await insertKindSchema(
        fixture.client,
        owner.userId,
        kindBody("candidate", [field]),
      );
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      let version = 1;
      for (const [originalName, mimeType, bytes] of FILES) {
        const reserved = await beginRecordFileUpload(
          owner,
          {
            recordId: candidateId,
            originalName,
            mimeType,
            sizeBytes: bytes.length,
            clientUploadId: randomUUID(),
          },
          fake.gateway,
        );
        const [row] = (
          await fixture.client.query<{ object_key: string }>(
            "SELECT object_key FROM app.record_files WHERE id=$1",
            [reserved.data.id],
          )
        ).rows;
        fake.objects.set(row.object_key, {
          bytes: Buffer.from(bytes),
          mimeType,
        });
        const ready = await completeRecordFileUpload(
          owner,
          reserved.data.id,
          fake.gateway,
        );
        version = (
          await updateRecord(owner, "candidates", candidateId, {
            version,
            data: { customValues: { [field.key]: ready.id } },
          })
        ).version;
        const response = await fileChunkRoute(
          new Request(
            `http://localhost:3000/api/v1/record-files/${ready.id}/chunks?index=0`,
            { headers: { authorization: `Bearer ${token}` } },
          ),
          { params: Promise.resolve({ id: ready.id }) },
        );
        expect(response.status, mimeType).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        expect(response.headers.get("content-disposition")).toMatch(
          /^attachment;/,
        );
        expect(response.headers.get("content-disposition")).not.toMatch(
          /inline/i,
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          Buffer.from(bytes),
        );
      }
    });
  });
});
