// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import {
  anchorPosition,
  anchorRange,
  followAnchor,
  isRemoteDocumentRebuild,
  resolveAnchor,
} from "./anchors";
import { createStandaloneEditorExtensions } from "./config";

let pair: CollabPair | null = null;

afterEach(() => {
  pair?.destroy();
  pair = null;
});

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
    const anchor = anchorPosition(local.state, 7);

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
