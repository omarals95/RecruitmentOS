import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCvMetadata,
  validateCvBytes,
} from "../src/lib/storage-format.ts";

function zip(files: Record<string, string>): Buffer {
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

test("CV metadata rejects paths, mismatched extension/type and oversized uploads", () => {
  assert.throws(() => validateCvMetadata("../cv.pdf", "application/pdf", 100));
  assert.throws(() => validateCvMetadata("cv.pdf", "image/png", 100));
  assert.throws(() =>
    validateCvMetadata("cv.pdf", "application/pdf", 10 * 1024 * 1024 + 1),
  );
  assert.throws(() =>
    validateCvMetadata("mail.msg", "application/vnd.ms-outlook", 100),
  );
  assert.equal(
    validateCvMetadata("cv.jfif", "image/jpeg", 100).mimeType,
    "image/jpeg",
  );
});

test("file extension and MIME cannot disguise different signature bytes", () => {
  assert.throws(() =>
    validateCvBytes("cv.pdf", "application/pdf", Buffer.from("MZ executable")),
  );
  assert.doesNotThrow(() =>
    validateCvBytes(
      "cv.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.7\nfictional fixture"),
    ),
  );
  assert.doesNotThrow(() =>
    validateCvBytes(
      "cv.png",
      "image/png",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    ),
  );
});

test("DOCX requires a word-processing package rather than an arbitrary ZIP", () => {
  assert.throws(() =>
    validateCvBytes(
      "cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      zip({ "readme.txt": "hi" }),
    ),
  );
  assert.doesNotThrow(() =>
    validateCvBytes(
      "cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      zip({
        "[Content_Types].xml":
          '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "word/document.xml": "<w:document>fictional</w:document>",
      }),
    ),
  );
});

test("DOCX rejects unsafe archive paths and macro-enabled content", () => {
  const extras: Record<string, string>[] = [
    { "../escape": "bad" },
    { "word/vbaProject.bin": "macro" },
  ];
  for (const extra of extras) {
    assert.throws(() =>
      validateCvBytes(
        "cv.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        zip({
          "[Content_Types].xml":
            "<Types>application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml</Types>",
          "word/document.xml": "<w:document/>",
          ...extra,
        }),
      ),
    );
  }
});

test("an empty DOCX document element is still a valid document structure", () => {
  assert.doesNotThrow(() =>
    validateCvBytes(
      "cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      zip({
        "[Content_Types].xml":
          "<Types>application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml</Types>",
        "word/document.xml": "<w:document/>",
      }),
    ),
  );
});

test("Pages requires recognized Pages document structure", () => {
  assert.throws(() =>
    validateCvBytes(
      "cv.pages",
      "application/vnd.apple.pages",
      zip({ "word/document.xml": "not pages" }),
    ),
  );
  assert.doesNotThrow(() =>
    validateCvBytes(
      "cv.pages",
      "application/vnd.apple.pages",
      zip({
        "Index/Document.iwa": "fixture",
        "Metadata/Properties.plist": "<plist/>",
      }),
    ),
  );
});

test("archive declared expansion limit is checked before decompression", () => {
  const data = zip({ "word/document.xml": "small" });
  const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  data.writeUInt32LE(100_000_000, central + 24);
  assert.throws(() =>
    validateCvBytes(
      "cv.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data,
    ),
  );
});

test("renamed OLE files cannot pass Word checks by placing WordDocument text in arbitrary content", () => {
  const disguised = Buffer.alloc(1024);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(disguised);
  disguised.writeUInt16LE(0xfffe, 28);
  disguised.writeUInt16LE(9, 30);
  Buffer.from("WordDocument", "utf16le").copy(disguised, 600);
  assert.throws(() =>
    validateCvBytes("cv.doc", "application/msword", disguised),
  );
});

test("Word format detection follows the bounded CFB directory to its WordDocument stream", () => {
  const bytes = Buffer.alloc(2048),
    header = bytes.subarray(0, 512),
    fat = bytes.subarray(512, 1024),
    directory = bytes.subarray(1024, 1536);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(1, 48);
  header.writeUInt32LE(0xfffffffe, 68);
  header.fill(255, 76, 512);
  header.writeUInt32LE(0, 76);
  fat.fill(255);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  Buffer.from("Root Entry\0", "utf16le").copy(directory);
  directory.writeUInt16LE(22, 64);
  directory[66] = 5;
  Buffer.from("WordDocument\0", "utf16le").copy(directory, 128);
  directory.writeUInt16LE(26, 192);
  directory[194] = 2;
  directory.writeBigUInt64LE(100n, 248);
  assert.doesNotThrow(() =>
    validateCvBytes("cv.doc", "application/msword", bytes),
  );
});
