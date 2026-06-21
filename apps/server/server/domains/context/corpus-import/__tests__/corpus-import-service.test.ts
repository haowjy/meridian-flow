import { describe, expect, it } from "vitest";
import { createInMemoryUnifiedContextPortFactory } from "../../unified-context-port-factory.js";
import { createFixtureDriveImportSource } from "../adapters/fixture-drive-import-source.js";
import { createMammothDocumentConverter } from "../adapters/mammoth-document-converter.js";
import { createCorpusImportService } from "../corpus-import-service.js";

function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

describe("corpus import", () => {
  it("converts DOCX to markdown", async () => {
    const converter = createMammothDocumentConverter();
    const converted = await converter.convert({
      filename: "Opening Scene.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: minimalDocx({ heading: "Opening Scene", body: "A blade rang against jade." }),
    });

    expect(converted.markdown).toContain("# Opening Scene");
    expect(converted.markdown).toContain("A blade rang against jade.");
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("writes supported files into deterministic KB import paths and reports unsupported files", async () => {
    const contextPorts = createInMemoryUnifiedContextPortFactory();
    const imports = createCorpusImportService({
      contextPorts,
      converter: createMammothDocumentConverter(),
    });

    const result = await imports.importFiles({
      userId: "user-1",
      projectId: "project-1",
      source: { kind: "upload" },
      files: [
        {
          filename: "Chapter 1.txt",
          relativePath: "Book One/Chapter 1.txt",
          mimeType: "text/plain",
          bytes: utf8("The mountain woke."),
        },
        {
          filename: "cover.png",
          mimeType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      status: "imported",
      title: "Chapter 1",
      uri: "kb://imports/book-one/chapter-1.md",
    });
    expect(result.items[1]).toMatchObject({ status: "skipped", filename: "cover.png" });

    const port = contextPorts.forProject("project-1", "user-1");
    const read = await port.read("kb://imports/book-one/chapter-1.md");
    expect(read.ok && read.value.content).toBe("The mountain woke.\n");
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("suffixes target paths instead of overwriting existing KB imports", async () => {
    const contextPorts = createInMemoryUnifiedContextPortFactory();
    const imports = createCorpusImportService({
      contextPorts,
      converter: createMammothDocumentConverter(),
    });
    const input = {
      userId: "user-1",
      projectId: "project-1",
      source: { kind: "upload" as const },
      files: [
        {
          filename: "Notes.txt",
          mimeType: "text/plain",
          bytes: utf8("first"),
        },
      ],
    };

    const first = await imports.importFiles(input);
    const second = await imports.importFiles({
      ...input,
      files: [{ ...input.files[0], bytes: utf8("second") }],
    });

    expect(first.items[0]).toMatchObject({ status: "imported", uri: "kb://imports/notes.md" });
    expect(second.items[0]).toMatchObject({ status: "imported", uri: "kb://imports/notes-2.md" });

    const port = contextPorts.forProject("project-1", "user-1");
    const original = await port.read("kb://imports/notes.md");
    const suffixed = await port.read("kb://imports/notes-2.md");
    expect(original.ok && original.value.content).toBe("first\n");
    expect(suffixed.ok && suffixed.value.content).toBe("second\n");
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("imports fixture Drive files through the drive source port", async () => {
    const contextPorts = createInMemoryUnifiedContextPortFactory();
    const imports = createCorpusImportService({
      contextPorts,
      converter: createMammothDocumentConverter(),
      driveSource: createFixtureDriveImportSource(),
    });

    const result = await imports.importDriveFixture({ userId: "user-1", projectId: "project-1" });

    expect(result.requestedCount).toBe(3);
    expect(result.importedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.items.map((item) => item.status)).toEqual(["imported", "imported", "skipped"]);

    const port = contextPorts.forProject("project-1", "user-1");
    const read = await port.read("kb://imports/google-drive-import/chapter-one.md");
    expect(read.ok && read.value.content).toContain("Blackpine Sect");
  });
});

type DocxInput = { heading: string; body: string };

function minimalDocx(input: DocxInput): Uint8Array {
  return zipStored([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(input.heading)}</w:t></w:r></w:p>
    <w:p><w:r><w:t>${escapeXml(input.body)}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
    },
  ]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type ZipFile = { name: string; content: string };

function zipStored(files: ZipFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const crc = crc32(content);
    const local = new Uint8Array(30 + name.length + content.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, content.length, true);
    localView.setUint32(22, content.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(content, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, content.length, true);
    centralView.setUint32(24, content.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);

  const total = offset + centralSize + end.length;
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
