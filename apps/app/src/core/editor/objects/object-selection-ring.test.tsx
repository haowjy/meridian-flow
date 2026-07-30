// @vitest-environment jsdom
/**
 * The jade ring: one owner, and it survives a peer's write.
 *
 * Law 1's whole visible contract is that a click on an object reads back as a
 * selection. A mounted REACT node view is what makes either claim here mean
 * anything, because `EditorContent` is what makes TipTap use one at all —
 * without it the editor falls back to `renderHTML`, ProseMirror owns the DOM
 * outright, and neither failure can happen.
 *
 * The two claims need different documents underneath:
 *
 * - survival needs a REMOTE write, because y-prosemirror rebuilds the
 *   ProseMirror document from the Yjs type rather than applying the peer's
 *   steps, and that rebuild is what replaces the node views underneath a
 *   selection that never changed;
 * - one owner of the paint needs nothing but a selection, so it says so with
 *   one editor: a node view deriving its own border from `NodeViewProps`
 *   paints a second ring the moment the writer clicks.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent } from "@tiptap/react";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";
import { requireNode } from "@/test-support/standalone-editor";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => strings[0],
  t: (strings: TemplateStringsArray) => strings[0],
}));

const { SELECTED_OBJECT_CLASS } = await import("./ObjectPhysicsExtension");

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const OBJECTS: [label: string, nodeType: string, object: JSONContent][] = [
  ["a figure", "figure", { type: "figure", attrs: { src: "asset:1", caption: "" } }],
  [
    "a diagram",
    "code_block",
    {
      type: "code_block",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "graph TD;" }],
    },
  ],
];

const documentWith = (object: JSONContent): JSONContent => ({
  type: "doc",
  content: [paragraph("before"), object, paragraph("after")],
});

/** TipTap syncs a node view's selected state a frame late. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

/** Render the manuscript through React, or this file proves nothing. */
async function showNodeViews(page: ReactEditorFixture): Promise<void> {
  await page.render(<EditorContent editor={page.editor} />);
  // Guard the guard.
  expect(page.editor.view.dom.querySelector(".react-renderer")).not.toBeNull();
}

function ringIsPainted(editor: Editor): boolean {
  return Boolean(editor.view.dom.querySelector(`.${SELECTED_OBJECT_CLASS}`));
}

/** The object's own element, whose classes say how it is being painted. */
function objectElement(editor: Editor, nodeType: string): Element {
  const selector = nodeType === "figure" ? ".meridian-figure-node" : ".meridian-diagram-block";
  const element = editor.view.dom.querySelector(selector);
  if (!element) throw new Error(`no ${nodeType} element in the fixture`);
  return element;
}

async function selectObject(editor: Editor, type: string): Promise<void> {
  const { pos } = requireNode(editor, type);
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  });
  await settle();
}

describe.each(OBJECTS)("%s wearing the ring, while a peer writes", (_label, nodeType, object) => {
  let pair: CollabPair;
  let page: ReactEditorFixture;

  beforeEach(async () => {
    pair = createCollabPair(documentWith(object));
    page = createReactEditorFixture({ editor: pair.local });
    await showNodeViews(page);
  });

  afterEach(() => {
    page.destroy();
    pair.destroy();
  });

  async function peerTypesElsewhere(): Promise<void> {
    await act(async () => {
      pair.peer.commands.setTextSelection(1);
      pair.peer.commands.insertContent("peer ");
      pair.sync();
    });
    await settle();
  }

  it("keeps it through a peer's write elsewhere in the document", async () => {
    await selectObject(pair.local, nodeType);
    expect(ringIsPainted(pair.local)).toBe(true);

    await peerTypesElsewhere();

    expect(pair.local.state.selection).toBeInstanceOf(NodeSelection);
    expect(ringIsPainted(pair.local)).toBe(true);
  });

  it("still paints it when the writer selects the object again", async () => {
    await selectObject(pair.local, nodeType);
    await peerTypesElsewhere();

    await act(async () => {
      pair.local.commands.setTextSelection(1);
    });
    await settle();
    expect(ringIsPainted(pair.local)).toBe(false);

    await selectObject(pair.local, nodeType);
    expect(ringIsPainted(pair.local)).toBe(true);
  });
});

describe.each(OBJECTS)("%s the writer has just selected", (_label, nodeType, object) => {
  let page: ReactEditorFixture;

  beforeEach(async () => {
    page = createReactEditorFixture({ content: documentWith(object) });
    await showNodeViews(page);
  });

  afterEach(() => {
    page.destroy();
  });

  it("gains the ring and no other paint", async () => {
    // One owner for selection visuals. A node view that derived its own border
    // from `NodeViewProps.selected` would paint a second one — and that prop's
    // lifecycle does not survive the rebuild a peer's write causes, so the two
    // disagree for a frame while the selection never changed.
    const before = [...objectElement(page.editor, nodeType).classList].sort();

    await selectObject(page.editor, nodeType);

    expect([...objectElement(page.editor, nodeType).classList].sort()).toEqual(before);
    expect(page.editor.view.dom.querySelectorAll(`.${SELECTED_OBJECT_CLASS}`)).toHaveLength(1);
  });
});
