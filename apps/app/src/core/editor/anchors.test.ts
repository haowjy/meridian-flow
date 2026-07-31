// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import {
  anchorRange,
  followAnchor,
  followBlock,
  followNode,
  holdBlock,
  holdNode,
  isRemoteDocumentRebuild,
  type NodeHold,
  resolveAnchor,
} from "./anchors";
import { createStandaloneEditorExtensions } from "./config";

let pair: CollabPair | null = null;
let standalone: Editor | null = null;

afterEach(() => {
  pair?.destroy();
  pair = null;
  standalone?.destroy();
  standalone = null;
});

/** An editor with no shared document: the mapping is the whole story there. */
function mount(content: JSONContent[]): Editor {
  standalone?.destroy();
  standalone = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return standalone;
}

function blockStart(instance: Editor, index: number): number {
  let pos = 0;
  for (let before = 0; before < index; before += 1) {
    pos += instance.state.doc.child(before).nodeSize;
  }
  return pos;
}

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const doc: JSONContent = { type: "doc", content: [paragraph("first"), paragraph("second")] };

/** The transaction the peer's write landed as, once it has reached the local editor. */
function peerWrite(write: (pair: CollabPair) => void): {
  transaction: Transaction;
  remote: boolean;
} {
  if (!pair) throw new Error("no pair");
  const landed: Transaction[] = [];
  const listener = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.docChanged) landed.push(transaction);
  };
  pair.local.on("transaction", listener);
  write(pair);
  pair.sync();
  pair.local.off("transaction", listener);

  const transaction = landed.at(-1);
  if (!transaction) throw new Error("the peer's write never reached the local editor");
  return { transaction, remote: landed.some(isRemoteDocumentRebuild) };
}

describe("editor anchors under a peer's write", () => {
  it("reaches the local editor as one whole-document replace that reports every position deleted", () => {
    pair = createCollabPair(doc);
    const { transaction, remote } = peerWrite(({ peer }) => {
      peer.commands.insertContentAt(1, "PEER ");
    });

    expect(remote).toBe(true);
    // The fact the whole sweep exists for: mapping cannot describe this change.
    expect(transaction.steps).toHaveLength(1);
    expect(transaction.mapping.mapResult(8).deleted).toBe(true);
  });

  it("holds a range through a peer's insertion above it", () => {
    pair = createCollabPair(doc);
    const { local } = pair;
    const anchor = anchorRange(local.state, { from: 8, to: 14 });
    expect(local.state.doc.textBetween(8, 14)).toBe("second");

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.insertContentAt(1, "PEER ");
    });

    const at = followAnchor(local.state, anchor, transaction.mapping);
    expect(at).not.toBeNull();
    expect(local.state.doc.textBetween(at?.from ?? 0, at?.to ?? 0)).toBe("second");
  });

  it("holds a block seam through a peer's insertion above it", () => {
    pair = createCollabPair(doc);
    const { local } = pair;
    // A seam is an empty range: both of its edges are the same edge, which is
    // what keeps text a peer types there in front of the caret.
    const anchor = anchorRange(local.state, { from: 7, to: 7 });

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.insertContentAt(0, {
        type: "paragraph",
        content: [{ type: "text", text: "0" }],
      });
    });

    const at = followAnchor(local.state, anchor, transaction.mapping);
    // Still the seam before "second", which a new block above pushed down.
    expect(at?.from).toBe(10);
    expect(local.state.doc.resolve(at?.from ?? 0).nodeAfter?.textContent).toBe("second");
  });

  it("resolves a deleted range to the seam it left behind, which is why identity is the caller's job", () => {
    pair = createCollabPair(doc);
    const { local } = pair;
    const anchor = anchorRange(local.state, { from: 8, to: 14 });

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.deleteRange({ from: 7, to: 15 });
    });

    const at = followAnchor(local.state, anchor, transaction.mapping);
    expect(at).not.toBeNull();
    expect(local.state.doc.textBetween(at?.from ?? 0, at?.to ?? 0)).toBe("");
  });

  it("falls back to the mapping on an editor with no shared document", () => {
    const standalone = new Editor({
      element: document.createElement("div"),
      extensions: createStandaloneEditorExtensions(),
      content: doc,
    });
    const anchor = anchorRange(standalone.state, { from: 8, to: 14 });
    expect(anchor.relative).toBeNull();

    const transaction = standalone.state.tr.insertText("xx", 1);
    standalone.view.dispatch(transaction);

    expect(resolveAnchor(standalone.state, anchor, transaction.mapping)).toEqual({
      from: 10,
      to: 16,
    });
    standalone.destroy();
  });
});

describe("holding a block across a change", () => {
  /** Dispatch and answer where the hold landed, the way the surface does. */
  function afterDispatch(instance: Editor, hold: NodeHold, tr: Transaction): NodeHold | null {
    instance.view.dispatch(tr);
    return followBlock(instance.state, hold, tr.mapping);
  }

  function holdOf(instance: Editor, index: number): NodeHold {
    const hold = holdBlock(instance.state, blockStart(instance, index));
    if (!hold) throw new Error("no hold");
    return hold;
  }

  it("moves with the block when one is inserted above it", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const second = blockStart(instance, 1);
    const hold = holdOf(instance, 1);

    const tr = instance.state.tr.insert(0, instance.state.schema.nodes.paragraph.create());
    expect(afterDispatch(instance, hold, tr)?.from).toBe(second + 2);
  });

  it("lets go when the block itself is deleted", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    const middle = blockStart(instance, 1);
    const hold = holdOf(instance, 1);

    const tr = instance.state.tr.delete(middle, middle + instance.state.doc.child(1).nodeSize);
    expect(afterDispatch(instance, hold, tr)).toBeNull();
  });

  it("lets go when the block is swept up in a wider delete", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    const middle = blockStart(instance, 1);
    const hold = holdOf(instance, 1);

    const tr = instance.state.tr.delete(middle, instance.state.doc.content.size);
    expect(afterDispatch(instance, hold, tr)).toBeNull();
  });

  it("lets go when the block stops being a top-level block", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const second = blockStart(instance, 1);
    const hold = holdOf(instance, 1);

    const range = instance.state.doc.resolve(second + 1).blockRange();
    if (!range) throw new Error("fixture");
    const tr = instance.state.tr.wrap(range, [{ type: instance.state.schema.nodes.blockquote }]);
    // The paragraph is inside the quote now, so the position lands at depth 1
    // and no block surface can act on it: the hold lets go rather than
    // silently retargeting the quote the writer never approached.
    expect(afterDispatch(instance, hold, tr)).toBeNull();
    expect(instance.state.doc.nodeAt(second)?.type.name).toBe("blockquote");
  });

  it("leaves an untouched block alone", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const first = blockStart(instance, 0);
    const last = blockStart(instance, 1);
    const hold = holdOf(instance, 0);

    const tr = instance.state.tr.delete(last, instance.state.doc.content.size);
    expect(afterDispatch(instance, hold, tr)?.from).toBe(first);
  });

  it("keeps the block a writer is typing into", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const second = blockStart(instance, 1);
    const hold = holdOf(instance, 1);

    const tr = instance.state.tr.insertText("!", second + 1);
    expect(afterDispatch(instance, hold, tr)?.from).toBe(second);
  });

  it("keeps the block through a peer's write, which reports every position deleted", () => {
    pair = createCollabPair({ type: "doc", content: [paragraph("one"), paragraph("two")] });
    const second = blockStart(pair.local, 1);
    const hold = holdBlock(pair.local.state, second);
    if (!hold) throw new Error("no hold");

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.insertContentAt(1, "PEER ");
    });

    // What the mapping alone would have answered: gone, every time.
    expect(transaction.mapping.mapResult(second).deleted).toBe(true);

    const followed = followBlock(pair.local.state, hold, transaction.mapping);
    expect(followed?.from).toBe(second + 5);
    expect(pair.local.state.doc.resolve(followed?.from ?? 0).nodeAfter?.textContent).toBe("two");
  });

  it("lets go when a peer deletes the block", () => {
    pair = createCollabPair({
      type: "doc",
      content: [paragraph("one"), paragraph("two"), paragraph("three")],
    });
    const hold = holdBlock(pair.local.state, blockStart(pair.local, 1));
    if (!hold) throw new Error("no hold");

    const { transaction } = peerWrite(({ peer }) => {
      const at = blockStart(peer, 1);
      peer.commands.deleteRange({ from: at, to: at + peer.state.doc.child(1).nodeSize });
    });

    expect(followBlock(pair.local.state, hold, transaction.mapping)).toBeNull();
  });

  // The schema needs a block, so deleting the only one leaves an empty
  // paragraph standing where it was. Both seams resolve to that replacement's
  // own boundaries — uncollapsed, at depth 0, a perfectly good-looking block —
  // and a menu that trusted them would offer Delete for a paragraph the writer
  // never saw.
  it("lets go when a peer replaces the document's only block", () => {
    pair = createCollabPair({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Only" }] },
      ],
    });
    const hold = holdBlock(pair.local.state, 0);
    if (!hold) throw new Error("no hold");

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.deleteRange({ from: 0, to: peer.state.doc.content.size });
    });

    expect(pair.local.state.doc.childCount).toBe(1);
    expect(pair.local.state.doc.child(0).type.name).toBe("paragraph");
    expect(followBlock(pair.local.state, hold, transaction.mapping)).toBeNull();
  });
});

/**
 * A hold is not a block-level idea. An inline image lives in a paragraph's
 * inline content and a table cell lives two levels down, and both are things a
 * long-lived surface aims verbs at — so the identity behind a hold has to be
 * findable at any depth, with a run of text counting as ONE Yjs child.
 */
describe("holding a node nested inside the document", () => {
  const IMAGE_PARAGRAPH: JSONContent = {
    type: "paragraph",
    content: [
      { type: "text", text: "look " },
      { type: "image", attrs: { src: "asset:one" } },
      { type: "text", text: " there" },
    ],
  };

  function posOf(instance: Editor, typeName: string): number {
    let found: number | null = null;
    instance.state.doc.descendants((node, pos) => {
      if (found === null && node.type.name === typeName) found = pos;
      return found === null;
    });
    if (found === null) throw new Error(`no ${typeName} in the fixture`);
    return found;
  }

  it("keeps an inline image through a peer typing in front of it", () => {
    pair = createCollabPair({ type: "doc", content: [paragraph("first"), IMAGE_PARAGRAPH] });
    const { local } = pair;
    const at = posOf(local, "image");
    const hold = holdNode(local.state, at);
    expect(hold?.identity).not.toBeNull();

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.insertContentAt(posOf(peer, "image") - 1, "PEER");
    });

    // What the mapping alone would have answered: gone.
    expect(transaction.mapping.mapResult(at).deleted).toBe(true);
    if (!hold) throw new Error("no hold");
    const followed = followNode(local.state, hold, transaction.mapping);
    expect(followed?.from).toBe(at + 4);
    expect(local.state.doc.nodeAt(followed?.from ?? -1)?.type.name).toBe("image");
  });

  it("keeps a table cell through a peer's write in the paragraph above", () => {
    pair = createCollabPair({
      type: "doc",
      content: [
        paragraph("intro"),
        table([
          ["a", "b"],
          ["c", "d"],
        ]),
      ],
    });
    const { local } = pair;
    const at = secondCellPos(local);
    const hold = holdNode(local.state, at);
    expect(hold?.nodeType).toBe("table_cell");
    expect(hold?.identity).not.toBeNull();
    if (!hold) throw new Error("no hold");

    const { transaction } = peerWrite(({ peer }) => {
      peer.commands.insertContentAt(1, "PEER ");
    });

    const followed = followNode(local.state, hold, transaction.mapping);
    expect(followed?.from).toBe(at + 5);
    expect(local.state.doc.nodeAt(followed?.from ?? -1)?.textContent).toBe("b");
  });

  it("lets go when a peer deletes the row the held cell was in", () => {
    pair = createCollabPair({
      type: "doc",
      content: [
        table([
          ["a", "b"],
          ["c", "d"],
        ]),
      ],
    });
    const { local } = pair;
    const hold = holdNode(local.state, secondCellPos(local));
    if (!hold) throw new Error("no hold");

    const { transaction } = peerWrite(({ peer }) => {
      const row = peer.state.doc.resolve(secondCellPos(peer)).before(2);
      peer.commands.deleteRange({
        from: row,
        to: row + (peer.state.doc.nodeAt(row)?.nodeSize ?? 0),
      });
    });

    expect(followNode(local.state, hold, transaction.mapping)).toBeNull();
  });

  it("refuses a position that holds text rather than a node", () => {
    const instance = mount([paragraph("one")]);
    expect(holdNode(instance.state, 1)).toBeNull();
  });
});

/** The second cell of the first row: `b` in the fixtures above. */
function secondCellPos(instance: Editor): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (node.type.name !== "table_cell") return true;
    if (node.textContent === "b") found = pos;
    return found === null;
  });
  if (found === null) throw new Error("no second cell in the fixture");
  return found;
}

function table(rows: string[][]): JSONContent {
  return {
    type: "table",
    content: rows.map((cells) => ({
      type: "table_row",
      content: cells.map((text) => ({
        type: "table_cell",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      })),
    })),
  };
}
