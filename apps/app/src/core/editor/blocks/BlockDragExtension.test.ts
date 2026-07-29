// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createCollabPair } from "@/test-support/collab-editors";

import { createStandaloneEditorExtensions } from "../config";
import { beginBlockDrag, draggedBlockPos, endBlockDrag, liftBlockDrag } from "./BlockDragExtension";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function mount(content: JSONContent[]): Editor {
  editor?.destroy();
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

function blockPos(instance: Editor, index: number): number {
  let pos = 0;
  for (let before = 0; before < index; before += 1)
    pos += instance.state.doc.child(before).nodeSize;
  return pos;
}

/** A local edit above the held block — what the mapping alone can carry. */
function insertAtStart(instance: Editor) {
  instance.view.dispatch(
    instance.state.tr.insert(0, instance.state.schema.nodes.paragraph.create()),
  );
}

function deleteBlock(instance: Editor, index: number) {
  const pos = blockPos(instance, index);
  const node = instance.state.doc.child(index);
  instance.view.dispatch(instance.state.tr.delete(pos, pos + node.nodeSize));
}

describe("the document's hold on a dragged block", () => {
  it("follows the block when an edit lands above it", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    const held = blockPos(instance, 1);
    beginBlockDrag(instance, held);

    insertAtStart(instance);

    expect(draggedBlockPos(instance.state)).toBe(held + 2);
    expect(instance.state.doc.nodeAt(held + 2)?.textContent).toBe("two");
  });

  it("lets go when the block being held is deleted", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    beginBlockDrag(instance, blockPos(instance, 1));
    liftBlockDrag(instance);

    deleteBlock(instance, 1);

    expect(draggedBlockPos(instance.state)).toBeNull();
  });

  it("keeps its hold across an ordinary local edit", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const held = blockPos(instance, 1);
    beginBlockDrag(instance, held);

    instance.commands.insertContentAt(held + 2, "typed");

    expect(draggedBlockPos(instance.state)).toBe(held);
  });

  it("forgets the hold when the gesture ends", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    beginBlockDrag(instance, blockPos(instance, 1));
    endBlockDrag(instance);

    expect(draggedBlockPos(instance.state)).toBeNull();
  });

  it("survives a real peer's write, which reports every position deleted", () => {
    const pair = createCollabPair({
      type: "doc",
      content: [paragraph("one"), paragraph("two"), paragraph("three")],
    });
    try {
      const held = blockPos(pair.local, 1);
      beginBlockDrag(pair.local, held);
      liftBlockDrag(pair.local);

      pair.peer.commands.insertContentAt(1, "PEER ");
      pair.sync();

      // The gesture is still holding the paragraph the writer grabbed, five
      // characters further down the document than it was.
      expect(draggedBlockPos(pair.local.state)).toBe(held + 5);
      expect(pair.local.state.doc.nodeAt(held + 5)?.textContent).toBe("two");
    } finally {
      pair.destroy();
    }
  });

  it("lets go when a peer deletes the block under the pointer", () => {
    const pair = createCollabPair({
      type: "doc",
      content: [paragraph("one"), paragraph("two"), paragraph("three")],
    });
    try {
      beginBlockDrag(pair.local, blockPos(pair.local, 1));
      liftBlockDrag(pair.local);

      const pos = blockPos(pair.peer, 1);
      pair.peer.commands.deleteRange({
        from: pos,
        to: pos + pair.peer.state.doc.child(1).nodeSize,
      });
      pair.sync();

      expect(draggedBlockPos(pair.local.state)).toBeNull();
    } finally {
      pair.destroy();
    }
  });

  it("lets go when a peer replaces the only block the writer was dragging", () => {
    // A heading, so that deleting it leaves a block of a DIFFERENT type: the
    // schema needs one, and the empty paragraph it supplies stands exactly
    // where the dragged heading was. Its seams look like a living block, and
    // only the Yjs element behind it says the writer's block is gone. (Delete
    // a lone paragraph and Yjs keeps the same element, emptied — which is
    // also right: that block still exists.)
    const pair = createCollabPair({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Only" }] },
      ],
    });
    try {
      beginBlockDrag(pair.local, 0);
      liftBlockDrag(pair.local);
      expect(draggedBlockPos(pair.local.state)).toBe(0);

      pair.peer.commands.deleteRange({ from: 0, to: pair.peer.state.doc.content.size });
      pair.sync();

      expect(pair.local.state.doc.child(0).type.name).toBe("paragraph");
      expect(draggedBlockPos(pair.local.state)).toBeNull();
    } finally {
      pair.destroy();
    }
  });

  it("adds nothing to the writer's undo history", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const before = instance.state.doc.toJSON();

    beginBlockDrag(instance, blockPos(instance, 1));
    liftBlockDrag(instance);
    endBlockDrag(instance);

    // Picking a block up is not an edit: the document is untouched, so there
    // is nothing for a peer to receive and nothing for undo to reverse.
    expect(instance.state.doc.toJSON()).toEqual(before);
  });
});
