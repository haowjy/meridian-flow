import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
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
});

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
