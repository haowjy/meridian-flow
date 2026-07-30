// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { afterEach, describe, expect, it } from "vitest";

import { createCollabPair } from "@/test-support/collab-editors";

import { createStandaloneEditorExtensions } from "../config";
import { imageStandsInLine, imagesInLine, inLineScale } from "./image-line-placement";

let editor: Editor | null = null;
let pair: ReturnType<typeof createCollabPair> | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  pair?.destroy();
  pair = null;
});

const text = (value: string): JSONContent => ({ type: "text", text: value });
const image = (src: string): JSONContent => ({ type: "image", attrs: { src } });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function mount(content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

function inLinePositions(instance: Editor): number[] {
  return imagesInLine(instance.state.doc).map((decoration) => decoration.from);
}

function positionOf(instance: Editor, type: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

/**
 * What ProseMirror's own drop handler does with a dragged inline node, step for
 * step (`prosemirror-view`'s `handleDrop`): the landing is chosen against the
 * pre-drag document, the dragged node is removed because a drag MOVES, and the
 * landing is mapped through that removal before the node goes back in.
 */
function dropImageAt(instance: Editor, sourcePos: number, dropAt: number): void {
  const state = instance.state;
  const dragged = NodeSelection.create(state.doc, sourcePos);
  const slice = dragged.content();
  expect([slice.openStart, slice.openEnd, slice.content.childCount]).toEqual([0, 0, 1]);

  const landing = dropPoint(state.doc, dropAt, slice) ?? dropAt;
  const transaction = state.tr;
  dragged.replace(transaction);
  const at = transaction.mapping.map(landing);
  const node = slice.content.firstChild;
  if (!node) throw new Error("the drag carried nothing");
  transaction.replaceRangeWith(at, at, node);
  instance.view.dispatch(transaction);
}

describe("which pictures stand in a line", () => {
  it("marks a picture that shares its paragraph with words", () => {
    const instance = mount([paragraph(text("see "), image("asset:1"), text(" here"))]);

    expect(inLinePositions(instance)).toEqual([positionOf(instance, "image")]);
  });

  it("leaves a picture alone in its paragraph holding the column", () => {
    const instance = mount([paragraph(text("above")), paragraph(image("asset:1"))]);

    expect(inLinePositions(instance)).toEqual([]);
  });

  it("marks every picture in a paragraph that holds more than one", () => {
    const instance = mount([paragraph(image("asset:1"), image("asset:2"))]);

    expect(inLinePositions(instance)).toHaveLength(2);
  });

  it("reads pictures inside a list item and a heading, not just paragraphs", () => {
    const instance = mount([
      { type: "heading", attrs: { level: 2 }, content: [text("Trial "), image("asset:1")] },
      {
        type: "bullet_list",
        content: [{ type: "list_item", content: [paragraph(text("step "), image("asset:2"))] }],
      },
    ]);

    expect(inLinePositions(instance)).toHaveLength(2);
  });

  it("stops marking a picture once the words beside it are gone", () => {
    const instance = mount([paragraph(text("see "), image("asset:1"))]);
    expect(inLinePositions(instance)).toHaveLength(1);

    instance.view.dispatch(instance.state.tr.delete(1, 5));

    expect(inLinePositions(instance)).toEqual([]);
  });

  it("is read back off a node view's decorations", () => {
    const instance = mount([paragraph(text("see "), image("asset:1"))]);
    const decorations = imagesInLine(instance.state.doc);

    expect(imageStandsInLine(decorations)).toBe(true);
    expect(imageStandsInLine([])).toBe(false);
    expect(imageStandsInLine([{ spec: { pendingUpload: {} } }])).toBe(false);
  });
});

describe("the frame a picture in a line reserves", () => {
  it("shrinks the long edge and leaves a small picture alone", () => {
    expect(inLineScale(3200, 2000)).toBeCloseTo(240 / 3200);
    expect(inLineScale(1000, 3000)).toBeCloseTo(240 / 3000);
    expect(inLineScale(200, 120)).toBe(1);
  });
});

describe("a drop between two words", () => {
  it("splices the picture into the sentence it was dropped into", () => {
    const instance = mount([
      paragraph(text("frost bloomed "), image("asset:1")),
      paragraph(text("A second paragraph waits below")),
    ]);
    const source = positionOf(instance, "image");
    // Between "paragraph" and "waits", inside the second paragraph's text.
    const midSentence = instance.state.doc.content.size - "waits below".length - 1;

    dropImageAt(instance, source, midSentence);

    expect(instance.state.doc.toJSON().content).toEqual([
      {
        type: "paragraph",
        attrs: { align: null },
        content: [{ type: "text", text: "frost bloomed " }],
      },
      {
        type: "paragraph",
        attrs: { align: null },
        content: [
          { type: "text", text: "A second paragraph " },
          { type: "image", attrs: { src: "asset:1", alt: null, title: null, uploadToken: null } },
          { type: "text", text: "waits below" },
        ],
      },
    ]);
    expect(inLinePositions(instance)).toHaveLength(1);
  });

  it("makes a paragraph of its own for a picture dropped at a block seam", () => {
    const instance = mount([
      paragraph(text("frost bloomed "), image("asset:1")),
      paragraph(text("A second paragraph")),
    ]);
    const source = positionOf(instance, "image");
    const seam = instance.state.doc.child(0).nodeSize;

    dropImageAt(instance, source, seam);

    expect(
      instance.state.doc.toJSON().content?.map((block: { type: string }) => block.type),
    ).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(instance.state.doc.child(1).childCount).toBe(1);
    expect(instance.state.doc.child(1).firstChild?.type.name).toBe("image");
    expect(inLinePositions(instance)).toEqual([]);
  });
});

describe("a collaborator", () => {
  it("derives the same placement from the same paragraph", () => {
    pair = createCollabPair({
      type: "doc",
      content: [paragraph(text("see "), image("asset:1"), text(" here")), paragraph(text("tail"))],
    });
    pair.sync();

    expect(inLinePositions(pair.peer)).toEqual(inLinePositions(pair.local));
    expect(inLinePositions(pair.peer)).toHaveLength(1);
  });
});
