// Document-renderer block selection and agent-facing text rendering contracts.
import { describe, expect, it } from "vitest";

import {
  collisionMarkdown,
  prefixCollisionFixture,
} from "../resolver/test-support/hash-collision.js";
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

  it("renders every candidate for an ambiguous file hash fragment", () => {
    const doc = createDoc(collisionMarkdown(), 100);
    const renderer = createDocumentRenderer({ model, codec });
    const fixture = prefixCollisionFixture(model, model.getBlocks(doc));

    const selection = renderer.selectReadBlocks(
      doc,
      { command: "read", file: `chapter.md#${fixture.sharedPrefix}` },
      { filePath: "chapter.md", fragment: fixture.sharedPrefix },
    );

    expect(selection).toMatchObject({ ok: true });
    if (!selection.ok) throw new Error(selection.message);
    expect(selection.blocks).toEqual(fixture.candidates.map((candidate) => candidate.block));
    const rendered = renderer.renderBlocks(doc, selection.blocks);
    for (const candidate of fixture.candidates) {
      expect(rendered).toContain(`${candidate.displayHash}|${model.getText(candidate.block)}`);
    }
    expect(rendered).not.toContain("not found");
  });

  it("renders exactly one block for a unique file hash prefix", () => {
    const doc = createDoc(numberedBlocks(32), 100);
    const renderer = createDocumentRenderer({ model, codec });
    const target = model.getBlocks(doc)[10];
    const prefix = uniquePrefixFor(doc, target);

    const selection = renderer.selectReadBlocks(
      doc,
      { command: "read", file: `chapter.md#${prefix}` },
      { filePath: "chapter.md", fragment: prefix },
    );

    expect(selection).toMatchObject({ ok: true });
    if (!selection.ok) throw new Error(selection.message);
    expect(selection.blocks).toEqual([target]);
    expect(renderedBlockBodies(renderer.renderBlocks(doc, selection.blocks))).toEqual(["Block 11"]);
  });

  it("renders the displayed collision hash uniquely and the shorter shared prefix as candidates", () => {
    const doc = createDoc(collisionMarkdown(), 100);
    const renderer = createDocumentRenderer({ model, codec });
    const fixture = prefixCollisionFixture(model, model.getBlocks(doc));

    const displayed = renderer.selectReadBlocks(
      doc,
      { command: "read", file: `chapter.md#${fixture.target.displayHash}` },
      { filePath: "chapter.md", fragment: fixture.target.displayHash },
    );
    expect(displayed).toMatchObject({ ok: true });
    if (!displayed.ok) throw new Error(displayed.message);
    expect(displayed.blocks).toEqual([fixture.target.block]);
    expect(renderedBlockBodies(renderer.renderBlocks(doc, displayed.blocks))).toEqual([
      model.getText(fixture.target.block),
    ]);

    const shared = renderer.selectReadBlocks(
      doc,
      { command: "read", file: `chapter.md#${fixture.sharedPrefix}` },
      { filePath: "chapter.md", fragment: fixture.sharedPrefix },
    );
    expect(shared).toMatchObject({ ok: true });
    if (!shared.ok) throw new Error(shared.message);
    expect(shared.blocks).toEqual(fixture.candidates.map((candidate) => candidate.block));
  });

  it("keeps heading-hash file fragments section scoped", () => {
    const doc = createDoc("# One\n\nAlpha\n\n## Two\n\nBeta\n\n# Three\n\nGamma", 100);
    const renderer = createDocumentRenderer({ model, codec });
    const headingHash = hashAt(doc, 2);

    const selection = renderer.selectReadBlocks(
      doc,
      { command: "read", file: `chapter.md#${headingHash}` },
      { filePath: "chapter.md", fragment: headingHash },
    );

    expect(selection).toMatchObject({ ok: true });
    if (!selection.ok) throw new Error(selection.message);
    expect(renderedBlockBodies(renderer.renderBlocks(doc, selection.blocks))).toEqual([
      "## Two",
      "Beta",
    ]);
  });

  it("keeps missing file hash fragments as not found", () => {
    const doc = createDoc("Alpha\n\nBeta", 100);
    const renderer = createDocumentRenderer({ model, codec });

    const selection = renderer.selectReadBlocks(
      doc,
      { command: "read", file: "chapter.md#deadbeef" },
      { filePath: "chapter.md", fragment: "deadbeef" },
    );

    expect(selection).toMatchObject({
      ok: false,
      code: "not_found",
      message: 'Section "#deadbeef" was not found',
    });
  });

  it("keeps slug fallback for hex-shaped read fragments", () => {
    const doc = createDoc("# cafe\n\nScene text\n\n# Next\n\nOther text", 100);
    const renderer = createDocumentRenderer({ model, codec });

    expect(model.lookupBlock(doc, "cafe")).toMatchObject({ ok: false, reason: "not_found" });
    const selection = renderer.selectReadBlocks(
      doc,
      { command: "read", file: "chapter.md#cafe" },
      { filePath: "chapter.md", fragment: "cafe" },
    );

    expect(selection).toMatchObject({ ok: true });
    if (!selection.ok) throw new Error(selection.message);
    expect(renderedBlockBodies(renderer.renderBlocks(doc, selection.blocks))).toEqual([
      "# cafe",
      "Scene text",
    ]);
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

function uniquePrefixFor(
  doc: ReturnType<typeof createDoc>,
  target: ReturnType<typeof model.getBlocks>[number],
): string {
  const targetFullHash = model.getBlockId(target);
  const displayHashes = model.getBlocks(doc).map((block) => model.getBlockId(block));
  for (let length = 1; length <= targetFullHash.length; length += 1) {
    const prefix = targetFullHash.slice(0, length);
    if (displayHashes.filter((hash) => hash.startsWith(prefix)).length === 1) return prefix;
  }
  throw new Error("Expected a unique full-hash prefix");
}
