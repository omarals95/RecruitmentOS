import { crc32, deflateSync } from "node:zlib";

// Synthetic CV files built from fictional text inside the tests; nothing is read from disk.

/** A PDF with one standard-font text line per entry, 60 lines a page, and a correct xref table. */
export function pdfWithText(lines: string[]): Buffer {
  const escape = (line: string) =>
    line.replace(/[\\()]/g, (char) => `\\${char}`);
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += 60)
    pages.push(lines.slice(i, i + 60));
  // 1 catalog, 2 page tree, 3 font, then a page and its content stream per page.
  const kids = pages.map((_, n) => `${4 + n * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  pages.forEach((page, n) => {
    const content = [
      "BT /F1 10 Tf 12 TL 40 800 Td",
      ...page.map((line) => `(${escape(line)}) Tj T*`),
      "ET",
    ].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${5 + n * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/**
 * A small, valid PDF (a decompression bomb): its page lists one FlateDecode content stream `copies`
 * times, and the stream inflates to one line of fictional text and `inflatedBytes` spaces.
 */
export function deflateBombPdf(inflatedBytes: number, copies = 1): Buffer {
  const stream = deflateSync(
    Buffer.concat([
      Buffer.from("BT /F1 10 Tf 40 800 Td (Fictional bomb CV) Tj ET\n"),
      Buffer.alloc(inflatedBytes, 0x20),
    ]),
    { level: 9 },
  );
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (part: string | Buffer) => {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part, "latin1");
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string | Buffer[]) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    for (const piece of typeof body === "string" ? [body] : body) add(piece);
    add("\nendobj\n");
  };
  add("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [${Array(copies).fill("4 0 R").join(" ")}] /Resources << /Font << /F1 5 0 R >> >> >>`,
  );
  object(4, [
    Buffer.from(
      `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    stream,
    Buffer.from("\nendstream", "latin1"),
  ]);
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xref = length;
  add(`xref\n0 6\n0000000000 65535 f \n`);
  for (let n = 1; n <= 5; n++)
    add(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** A stored (uncompressed) ZIP archive with correct CRCs. */
export function zip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = Buffer.from(name),
      data = Buffer.from(content),
      crc = crc32(data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
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

/** A minimal macro-free DOCX with one paragraph per entry. */
export function docxWithText(paragraphs: string[]): Buffer {
  const xml = (text: string) =>
    text.replace(
      /[<>&]/g,
      (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]!,
    );
  return zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map(
        (text) =>
          `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`,
      )
      .join("")}</w:body></w:document>`,
  });
}
