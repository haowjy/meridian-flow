import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import {
  blockHashesForDoc,
  DEFAULT_HASH_LENGTH,
  fullHashForItemId,
  getBlockItemId,
  getTopLevelXmlBlocks,
  lookupBlockHash,
} from "./block-hash.js";
import { yProsemirrorModel } from "./y-prosemirror.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

describe("yProsemirrorModel block hashes", () => {
  it("are deterministic for the same Y.Doc content", () => {
    const first = createDoc("# One\n\nAlpha\n\nBeta");
    const second = createDoc("# One\n\nAlpha\n\nBeta");
    expect(blockHashes(first)).toEqual(blockHashes(second));

    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, Y.encodeStateAsUpdate(first));
    expect(blockHashes(replayed)).toEqual(blockHashes(first));
  });

  it("uses default-width display hashes when no full-hash prefixes collide", () => {
    const doc = createDoc("# One\n\nAlpha\n\nBeta");

    const hashes = blockHashes(doc);

    expect(hashes).toHaveLength(3);
    expect(hashes.every((hash) => hash.length === DEFAULT_HASH_LENGTH)).toBe(true);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("displays the shortest full-hash prefix that resolves back to each block", () => {
    const doc = docWithDisplayExtension();
    const hashes = blockHashesForDoc(doc);

    expect(hashes.some((hash) => hash.length > DEFAULT_HASH_LENGTH)).toBe(true);
    expectEveryDisplayedHashResolvesToItsBlock(doc);
  });

  it("keeps a block hash stable when that block text changes", () => {
    const doc = createDoc("Alpha sword.\n\nBeta");
    const [first] = model.getBlocks(doc);
    const before = model.getBlockId(first);

    model.applyTextEdit(doc, first, { from: 6, to: 11 }, "blade");

    expect(model.getText(first)).toBe("Alpha blade.");
    expect(model.getBlockId(first)).toBe(before);
  });

  it("keeps other block hashes stable across block insert and delete", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const [alpha, beta, gamma] = model.getBlocks(doc);
    const before = new Map([
      [alpha, model.getBlockId(alpha)],
      [beta, model.getBlockId(beta)],
      [gamma, model.getBlockId(gamma)],
    ]);

    const [inserted] = model.insertBlocks(doc, alpha, codec.parse("Inserted"));

    expect(model.getBlockId(alpha)).toBe(before.get(alpha));
    expect(model.getBlockId(beta)).toBe(before.get(beta));
    expect(model.getBlockId(gamma)).toBe(before.get(gamma));

    model.deleteBlock(doc, inserted);
    model.deleteBlock(doc, beta);

    expect(model.getBlockId(alpha)).toBe(before.get(alpha));
    expect(model.getBlockId(gamma)).toBe(before.get(gamma));
  });

  it("keeps a held display hash resolvable when a different block changes", () => {
    const doc = createDoc("Alpha sword.\n\nBeta waits.\n\nGamma rests.");
    const blocks = getTopLevelXmlBlocks(doc);
    const modelBlocks = model.getBlocks(doc);
    const alphaHash = blockHashesForDoc(doc)[0];

    model.applyTextEdit(doc, modelBlocks[1], { from: 0, to: 4 }, "Delta");

    expect(blockHashesForDoc(doc)[0]).toBe(alphaHash);
    const lookup = lookupBlockHash(doc, alphaHash);
    expect(lookup).toMatchObject({ ok: true, hash: alphaHash });
    expect(lookup.ok && getBlockItemId(lookup.block)).toEqual(getBlockItemId(blocks[0]));
  });
});

describe("lookupBlockHash", () => {
  it("resolves an exact displayed hash", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const blocks = getTopLevelXmlBlocks(doc);
    const displayedHash = blockHashesForDoc(doc)[1];

    const lookup = lookupBlockHash(doc, displayedHash);

    expect(lookup).toMatchObject({ ok: true, hash: displayedHash });
    expect(lookup.ok && lookup.block).toBe(blocks[1]);
  });

  it("resolves a longer-than-current-display prefix", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const blocks = getTopLevelXmlBlocks(doc);
    const displayedHash = blockHashesForDoc(doc)[1];
    const longerPrefix = fullHash(blocks[1]).slice(0, displayedHash.length + 3);

    const lookup = lookupBlockHash(doc, longerPrefix);

    expect(lookup).toMatchObject({ ok: true, hash: longerPrefix });
    expect(lookup.ok && lookup.block).toBe(blocks[1]);
  });

  it("resolves a full hash", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const blocks = getTopLevelXmlBlocks(doc);
    const full = fullHash(blocks[2]);

    const lookup = lookupBlockHash(doc, full);

    expect(lookup).toMatchObject({ ok: true, hash: full });
    expect(lookup.ok && lookup.block).toBe(blocks[2]);
  });

  it("reports ambiguous for a shared full-hash prefix", () => {
    const doc = createDoc(numberedBlocks(32));
    const blocks = getTopLevelXmlBlocks(doc);
    const [prefix, first, second] = sharedFullHashPrefix(blocks);

    const lookup = lookupBlockHash(doc, prefix);

    expect(lookup.ok).toBe(false);
    expect(!lookup.ok && lookup.reason).toBe("ambiguous");
    expect(!lookup.ok && lookup.reason === "ambiguous" && lookup.matches).toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  it("reports not_found for a prefix matching no full hash", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const missingPrefix = absentPrefix(getTopLevelXmlBlocks(doc));

    expect(lookupBlockHash(doc, missingPrefix)).toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves case-insensitively", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const blocks = getTopLevelXmlBlocks(doc);
    const full = fullHash(blocks[0]);
    const prefix = full.slice(0, 8).toUpperCase();

    const lookup = lookupBlockHash(doc, prefix);

    expect(lookup).toMatchObject({ ok: true, hash: prefix.toLowerCase() });
    expect(lookup.ok && lookup.block).toBe(blocks[0]);
  });

  it("guards empty input", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");

    expect(lookupBlockHash(doc, "")).toEqual({ ok: false, reason: "not_found" });
    expect(lookupBlockHash(doc, "   ")).toEqual({ ok: false, reason: "not_found" });
  });
});

function docWithDisplayExtension(): Y.Doc {
  for (let blockCount = 256; blockCount <= 4096; blockCount *= 2) {
    const doc = createDoc(numberedBlocks(blockCount));
    if (blockHashesForDoc(doc).some((hash) => hash.length > DEFAULT_HASH_LENGTH)) return doc;
  }
  throw new Error("Expected generated document to contain a display hash collision");
}

function expectEveryDisplayedHashResolvesToItsBlock(doc: Y.Doc): void {
  const blocks = getTopLevelXmlBlocks(doc);
  const hashes = blockHashesForDoc(doc);

  expect(hashes).toHaveLength(blocks.length);
  for (let i = 0; i < blocks.length; i += 1) {
    const lookup = lookupBlockHash(doc, hashes[i]);
    expect(lookup).toMatchObject({ ok: true, hash: hashes[i] });
    expect(lookup.ok && getBlockItemId(lookup.block)).toEqual(getBlockItemId(blocks[i]));
  }
}

function createDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

function blockHashes(doc: Y.Doc): string[] {
  return model.getDocumentBlockIds(doc);
}

function fullHash(block: Y.XmlElement): string {
  return fullHashForItemId(getBlockItemId(block));
}

function numberedBlocks(count: number): string {
  return Array.from({ length: count }, (_, i) => `Block ${i}`).join("\n\n");
}

function sharedFullHashPrefix(
  blocks: Y.XmlElement[],
): [prefix: string, first: Y.XmlElement, second: Y.XmlElement] {
  const byFirstNibble = new Map<string, Y.XmlElement>();
  for (const block of blocks) {
    const nibble = fullHash(block)[0];
    const first = byFirstNibble.get(nibble);
    if (first) return [commonPrefix(fullHash(first), fullHash(block)), first, block];
    byFirstNibble.set(nibble, block);
  }
  throw new Error("Expected at least two blocks to share a full-hash prefix");
}

function commonPrefix(first: string, second: string): string {
  let length = 0;
  while (length < first.length && first[length] === second[length]) length += 1;
  return first.slice(0, length);
}

function absentPrefix(blocks: Y.XmlElement[]): string {
  const firstNibbles = new Set(blocks.map((block) => fullHash(block)[0]));
  for (const prefix of "0123456789abcdef") {
    if (!firstNibbles.has(prefix)) return prefix;
  }
  throw new Error("Expected a missing one-character prefix");
}
