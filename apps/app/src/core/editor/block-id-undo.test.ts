// @vitest-environment jsdom
/** A block's id survives Undo: the history never takes identity away from a block a peer wrote into. */
import { expect, it } from "vitest";
import { createCollabPair } from "@/test-support/collab-editors";

// Risk: a peer's text left in a paragraph with no id, which an edit addressed by block cannot reach.
it("keeps a paragraph's id when its first typist undoes after a peer typed into it", () => {
  const pair = createCollabPair({ type: "doc", content: [{ type: "paragraph" }] });
  try {
    pair.local.commands.insertContent("A");
    pair.sync();
    pair.peer.commands.insertContent("B");
    pair.sync();
    pair.local.commands.undo();
    pair.sync();

    const paragraph = pair.local.getJSON().content?.[0];
    expect(pair.local.state.doc.textContent).toBe("B");
    expect(paragraph?.attrs?.id).toEqual(expect.any(String));
  } finally {
    pair.destroy();
  }
});
