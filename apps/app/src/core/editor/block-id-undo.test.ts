// @vitest-environment jsdom
/** A block's id survives Undo: the history never takes identity away from a block a peer wrote into. */
import { expect, it } from "vitest";
import * as Y from "yjs";
import { createReviewEditor, destroyReviewEditors } from "@/test-support/inline-review-editor";

// Risk: a peer's text left in a paragraph with no id, which a Draft cannot be seeded from.
it("keeps a paragraph's id when its first typist undoes after a peer typed into it", () => {
  const first = createReviewEditor([]);
  try {
    first.editor.commands.insertContent("A");
    const peerDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(first.doc));
    const peer = createReviewEditor([], peerDoc);
    peer.editor.commands.insertContent("B");
    const sync = () => {
      Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(peerDoc));
      Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(first.doc));
    };
    sync();
    first.editor.commands.undo();
    sync();

    const paragraph = first.editor.getJSON().content?.[0];
    expect(first.editor.state.doc.textContent).toBe("B");
    expect(paragraph?.attrs?.id).toEqual(expect.any(String));
  } finally {
    destroyReviewEditors();
  }
});
