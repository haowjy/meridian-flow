// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

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

/** What a peer's write looks like from here: a transaction nobody local made. */
function peerInsertAtStart(instance: Editor) {
  instance.view.dispatch(
    instance.state.tr.insert(0, instance.state.schema.nodes.paragraph.create()),
  );
}

function peerDeleteBlock(instance: Editor, index: number) {
  const pos = blockPos(instance, index);
  const node = instance.state.doc.child(index);
  instance.view.dispatch(instance.state.tr.delete(pos, pos + node.nodeSize));
}

describe("the document's hold on a dragged block", () => {
  it("follows the block when a peer writes above it", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    const held = blockPos(instance, 1);
    beginBlockDrag(instance, held);

    peerInsertAtStart(instance);

    expect(draggedBlockPos(instance.state)).toBe(held + 2);
    expect(instance.state.doc.nodeAt(held + 2)?.textContent).toBe("two");
  });

  it("lets go when a peer deletes the block being held", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    beginBlockDrag(instance, blockPos(instance, 1));
    liftBlockDrag(instance);

    peerDeleteBlock(instance, 1);

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
