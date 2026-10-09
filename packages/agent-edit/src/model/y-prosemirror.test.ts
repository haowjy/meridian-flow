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

describe("yProsemirrorModel inline run count", () => {
  it.each([
    ["plain prose", 1],
    ["plain **bold** plain", 3],
    ["- first\n- second", 2],
    ["![image](https://example.com/image.png)", 0],
  ])("counts nonempty delta runs in %s", (content, expected) => {
    const doc = createDoc(content);
    expect(model.inlineRunCount(model.getBlocks(doc)[0])).toBe(expected);
  });
});

describe("yProsemirrorModel block hashes", () => {
  it("displays the shortest full-hash prefix that resolves back to each block", () => {
    const doc = docWithDisplayExtension();
    const hashes = blockHashesForDoc(doc);

    expect(hashes.some((hash) => hash.length > DEFAULT_HASH_LENGTH)).toBe(true);
    expectEveryDisplayedHashResolvesToItsBlock(doc);
  });
});

describe("lookupBlockHash", () => {
  it("resolves a longer-than-current-display prefix", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const blocks = getTopLevelXmlBlocks(doc);
    const displayedHash = blockHashesForDoc(doc)[1];
    const longerPrefix = fullHash(blocks[1]).slice(0, displayedHash.length + 3);

    const lookup = lookupBlockHash(doc, longerPrefix);

    expect(lookup).toMatchObject({ ok: true, hash: longerPrefix });
    expect(lookup.ok && lookup.block).toBe(blocks[1]);
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

function fullHash(block: Y.XmlElement): string {
  return fullHashForItemId(getBlockItemId(block));
}

function numberedBlocks(count: number): string {
  return Array.from({ length: count }, (_, i) => `Block ${i}`).join("\n\n");
}
