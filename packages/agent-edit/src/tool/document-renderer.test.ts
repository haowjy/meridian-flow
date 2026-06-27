// Document-renderer block selection and agent-facing text rendering contracts.
import { describe, expect, it } from "vitest";

import { createDocumentRenderer } from "./document-renderer.js";
import { hashAt, renderedBlockBodies } from "./test-support/assertions.js";
import { codec, createDoc, model } from "./test-support/write-tool-harness.js";

describe("document renderer", () => {
  it("renders block-hashed document content and scoped outline sections", () => {
    const doc = createDoc("# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits.", 100);
    const renderer = createDocumentRenderer({ model, codec });

    const full = renderer.renderBlocks(doc, model.getBlocks(doc));

    expect(full).toMatch(/^[0-9a-f]{4}\|# Chapter/m);
    expect(full).toContain("|Alpha sword.");

    const headingHash = hashAt(doc, 2);
    const section = renderer.selectReadBlocks(
      doc,
      { command: "read", file: `chapter.md#${headingHash}` },
      { filePath: "chapter.md", fragment: headingHash },
    );

    expect(section).toMatchObject({ ok: true });
    if (!section.ok) throw new Error(section.message);
    const sectionText = renderer.renderBlocks(doc, section.blocks);
    expect(sectionText).toContain("|## Arena");
    expect(sectionText).toContain("|Beta waits.");

    const outline = renderer.renderOutline(doc, model.getBlocks(doc), "chapter.md");
    expect(outline).toContain(`write(command="read", file="chapter.md#${headingHash}")`);
  });

  it("selects around windows with radius three and clamps at document edges", () => {
    const doc = createDoc(numberedBlocks(9), 100);
    const renderer = createDocumentRenderer({ model, codec });
    const middleHash = hashAt(doc, 4);
    const nearStartHash = hashAt(doc, 1);
    const nearEndHash = hashAt(doc, 7);

    const middle = selectedReadText(renderer, doc, middleHash);
    const middleWithHashPrefix = selectedReadText(renderer, doc, `#${middleHash}`);
    const nearStart = selectedReadText(renderer, doc, nearStartHash);
    const nearEnd = selectedReadText(renderer, doc, nearEndHash);

    expect(renderedBlockBodies(middle)).toEqual([
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
    ]);
    expect(middleWithHashPrefix).toBe(middle);
    expect(renderedBlockBodies(nearStart)).toEqual([
      "Block 1",
      "Block 2",
      "Block 3",
      "Block 4",
      "Block 5",
    ]);
    expect(renderedBlockBodies(nearEnd)).toEqual([
      "Block 5",
      "Block 6",
      "Block 7",
      "Block 8",
      "Block 9",
    ]);
  });
});

function selectedReadText(
  renderer: ReturnType<typeof createDocumentRenderer>,
  doc: ReturnType<typeof createDoc>,
  around: string,
): string {
  const selection = renderer.selectReadBlocks(
    doc,
    { command: "read", file: "chapter.md", around },
    { filePath: "chapter.md" },
  );
  if (!selection.ok) throw new Error(selection.message);
  return renderer.renderBlocks(doc, selection.blocks);
}

function numberedBlocks(count: number): string {
  return Array.from({ length: count }, (_, index) => `Block ${index + 1}`).join("\n\n");
}
