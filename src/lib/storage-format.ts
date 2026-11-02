import { inflateRawSync } from "node:zlib";

export const MAX_CV_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  pages: "application/vnd.apple.pages",
};

export class CvValidationError extends Error {}
function invalid(message: string): never {
  throw new CvValidationError(message);
}
export function cvExtension(name: string): string {
  return name.toLowerCase().split(".").at(-1) ?? "";
}
export function containsControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
}

export function validateCvMetadata(
  originalName: string,
  mimeType: string,
  sizeBytes: number,
) {
  const name = originalName.trim();
  if (
    !name ||
    name.length > 180 ||
    /[/\\:]/.test(name) ||
    containsControlCharacters(name) ||
    name.startsWith(".")
  )
    invalid("Use a plain CV filename without a folder path.");
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_CV_BYTES
  )
    invalid("CV files must be between 1 byte and 10 MiB.");
  const expected = MIME[cvExtension(name)];
  if (!expected)
    invalid(
      "Supported CV formats: PDF, DOC, DOCX, JPG, JPEG, JFIF, PNG and Pages.",
    );
  const supplied = mimeType.trim().toLowerCase();
  if (
    supplied &&
    supplied !== "application/octet-stream" &&
    supplied !== expected
  )
    invalid("The declared file type does not match the CV filename.");
  return { originalName: name, mimeType: expected, sizeBytes };
}

function validateWordBinary(bytes: Buffer) {
  if (
    bytes.length < 1536 ||
    !bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")) ||
    bytes.readUInt16LE(28) !== 0xfffe
  )
    invalid("The file does not contain a Word binary document.");
  const major = bytes.readUInt16LE(26),
    shift = bytes.readUInt16LE(30);
  if (
    !((major === 3 && shift === 9) || (major === 4 && shift === 12)) ||
    bytes.readUInt16LE(32) !== 6
  )
    invalid("The Word binary header is invalid.");
  const sectorSize = 2 ** shift,
    sectors = bytes.length / sectorSize - 1;
  if (!Number.isInteger(sectors))
    invalid("The Word binary file has incomplete sectors.");
  const sector = (id: number) => {
    if (id >= sectors) invalid("The Word binary sector is outside the file.");
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const fatCount = bytes.readUInt32LE(44),
    fatIds: number[] = [];
  if (!fatCount || fatCount > sectors)
    invalid("The Word binary allocation table is invalid.");
  for (let i = 0; i < 109; i++) {
    const id = bytes.readUInt32LE(76 + i * 4);
    if (id !== 0xffffffff) fatIds.push(id);
  }
  let difat = bytes.readUInt32LE(68);
  const seenDifat = new Set<number>();
  const difatCount = bytes.readUInt32LE(72);
  if (difatCount > sectors)
    invalid("The Word binary extended allocation table is invalid.");
  for (let i = 0; i < difatCount; i++) {
    if (seenDifat.has(difat))
      invalid("The Word binary allocation table contains a cycle.");
    seenDifat.add(difat);
    const block = sector(difat);
    for (let j = 0; j < sectorSize / 4 - 1; j++) {
      const id = block.readUInt32LE(j * 4);
      if (id !== 0xffffffff) fatIds.push(id);
    }
    difat = block.readUInt32LE(sectorSize - 4);
  }
  if (fatIds.length !== fatCount || new Set(fatIds).size !== fatCount)
    invalid("The Word binary allocation table does not match its header.");
  const fat = Buffer.concat(fatIds.map(sector)),
    seenDirectory = new Set<number>();
  let directory = bytes.readUInt32LE(48),
    found = false,
    root = false;
  while (directory !== 0xfffffffe) {
    if (
      seenDirectory.has(directory) ||
      seenDirectory.size > sectors ||
      directory * 4 + 4 > fat.length
    )
      invalid("The Word binary directory contains a cycle or invalid sector.");
    seenDirectory.add(directory);
    const block = sector(directory);
    for (let pos = 0; pos < sectorSize; pos += 128) {
      const length = block.readUInt16LE(pos + 64),
        kind = block[pos + 66];
      if (!kind) continue;
      if (length < 2 || length > 64 || length % 2)
        invalid("The Word binary stream name is invalid.");
      const name = block.subarray(pos, pos + length - 2).toString("utf16le");
      if (kind === 5 && name === "Root Entry") root = true;
      if (
        kind === 2 &&
        name === "WordDocument" &&
        block.readBigUInt64LE(pos + 120) > 0n
      )
        found = true;
    }
    directory = fat.readUInt32LE(directory * 4);
  }
  if (!found || !root)
    invalid("The file does not contain a recognized WordDocument stream.");
}

function archiveFiles(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > MAX_CV_BYTES || bytes.length < 22)
    invalid("Invalid document archive.");
  let end = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65_557);
    i--
  ) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    invalid("Split archives are not supported.");
  const count = bytes.readUInt16LE(end + 10),
    dirSize = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  if (
    !count ||
    count > 500 ||
    count !== bytes.readUInt16LE(end + 8) ||
    start + dirSize !== end
  )
    invalid("Archive structure or file count is invalid.");
  let pos = start,
    total = 0;
  const files = new Map<string, Buffer>(),
    occupied: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50)
      invalid("Invalid archive directory.");
    const flags = bytes.readUInt16LE(pos + 8),
      method = bytes.readUInt16LE(pos + 10);
    const packed = bytes.readUInt32LE(pos + 20),
      size = bytes.readUInt32LE(pos + 24);
    const nameLen = bytes.readUInt16LE(pos + 28),
      extra = bytes.readUInt16LE(pos + 30),
      comment = bytes.readUInt16LE(pos + 32);
    const offset = bytes.readUInt32LE(pos + 42),
      next = pos + 46 + nameLen + extra + comment;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > 8 * 1024 * 1024 ||
      packed > MAX_CV_BYTES ||
      offset === 0xffffffff ||
      next > end
    )
      invalid("Encrypted, ZIP64 or oversized archive entries are unsupported.");
    total += size;
    if (
      total > 30 * 1024 * 1024 ||
      (size > 1024 * 1024 && size > Math.max(packed, 1) * 200)
    )
      invalid("Archive expands beyond the safe processing limit.");
    const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen),
      name = nameBytes.toString("utf8");
    if (
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.includes(":") ||
      containsControlCharacters(name) ||
      name.split("/").includes("..") ||
      files.has(name.toLowerCase())
    )
      invalid("Unsafe or duplicate archive filename.");
    if (
      offset + 30 > start ||
      bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method
    )
      invalid("Archive entry headers do not match.");
    const localNameLen = bytes.readUInt16LE(offset + 26),
      localExtra = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLen + localExtra,
      dataEnd = dataStart + packed;
    if (
      dataEnd > start ||
      !bytes
        .subarray(offset + 30, offset + 30 + localNameLen)
        .equals(nameBytes) ||
      occupied.some(([a, b]) => offset < b && dataEnd > a)
    )
      invalid("Overlapping or truncated archive entry.");
    occupied.push([offset, dataEnd]);
    let data: Buffer;
    try {
      data =
        method === 0
          ? bytes.subarray(dataStart, dataEnd)
          : inflateRawSync(bytes.subarray(dataStart, dataEnd), {
              maxOutputLength: Math.min(size + 1, 8 * 1024 * 1024 + 1),
            });
    } catch {
      invalid("The document archive cannot be decompressed safely.");
    }
    if (data.length !== size)
      invalid("Archive entry size does not match its contents.");
    files.set(name.toLowerCase(), data);
    pos = next;
  }
  if (pos !== end) invalid("Unexpected archive directory data.");
  return files;
}

/** A bounded format check, not malware scanning or a claim that embedded content is safe. */
export function validateCvBytes(
  name: string,
  mimeType: string,
  bytes: Buffer,
): void {
  const ext = cvExtension(name);
  validateCvMetadata(name, mimeType, Math.min(bytes.length, MAX_CV_BYTES));
  if (ext === "pdf") {
    if (
      !bytes
        .subarray(0, 8)
        .toString("ascii")
        .match(/^%PDF-[12]\.[0-9]/)
    )
      invalid("The file does not contain a PDF signature.");
  } else if (["jpg", "jpeg", "jfif"].includes(ext)) {
    if (
      bytes.length < 3 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes[2] !== 255
    )
      invalid("The file does not contain a JPEG signature.");
  } else if (ext === "png") {
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      invalid("The file does not contain a PNG signature.");
  } else if (ext === "doc") {
    validateWordBinary(bytes);
  } else {
    const files = archiveFiles(bytes);
    if (ext === "docx") {
      const types = files.get("[content_types].xml")?.toString("utf8") ?? "";
      const document = files.get("word/document.xml")?.toString("utf8") ?? "";
      if (
        !types.includes(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ) ||
        !document.match(/<(?:[A-Za-z0-9_-]+:)?document(?:\s|\/?>)/) ||
        [...files.keys()].some(
          (k) => k.includes("vbaproject") || k.endsWith(".exe"),
        ) ||
        /<!DOCTYPE|<!ENTITY/i.test(types + document)
      )
        invalid("The file is not a supported macro-free DOCX document.");
    } else if (ext === "pages") {
      if (
        !(
          files.has("index/document.iwa") &&
          files.has("metadata/properties.plist")
        ) &&
        !files.has("index.xml")
      )
        invalid("The file does not contain a recognized Pages document.");
    }
  }
}
