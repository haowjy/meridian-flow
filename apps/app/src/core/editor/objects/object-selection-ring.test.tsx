// @vitest-environment jsdom
/**
 * The jade ring survives a peer's write.
 *
 * Law 1's whole visible contract is that a click on an object reads back as a
 * selection. Two things have to be real for this to mean anything:
 *
 * - a REMOTE write, because y-prosemirror rebuilds the ProseMirror document
 *   from the Yjs type rather than applying the peer's steps, and that rebuild
 *   is what replaces the node views underneath a selection that never changed;
 * - a mounted REACT node view, because `EditorContent` is what makes TipTap use
 *   one at all. Without it the editor falls back to `renderHTML`, ProseMirror
 *   owns the DOM outright, and the bug cannot happen.
 *
 * Miss either and this file passes while the writer's ring is gone.
 */
import type { JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent } from "@tiptap/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => strings[0],
  t: (strings: TemplateStringsArray) => strings[0],
}));

const { SELECTED_OBJECT_CLASS } = await import("./ObjectPhysicsExtension");

let pair: CollabPair | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  pair?.destroy();
  pair = null;
  root = null;
  host = null;
});

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

/** TipTap syncs a node view's selected state a frame late. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

function ringIsPainted(): boolean {
  return Boolean(pair?.local.view.dom.querySelector(`.${SELECTED_OBJECT_CLASS}`));
}

/** The object's own element, whose classes say how it is being painted. */
function objectElement(nodeType: string): Element {
  const selector = nodeType === "figure" ? ".meridian-figure-node" : ".meridian-diagram-block";
  const element = pair?.local.view.dom.querySelector(selector);
  if (!element) throw new Error(`no ${nodeType} element in the fixture`);
  return element;
}

function positionOf(type: string): number {
  let found: number | null = null;
  pair?.local.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

async function selectObject(type: string): Promise<void> {
  const pos = positionOf(type);
  await act(async () => {
    const editor = pair?.local;
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  });
  await settle();
}

async function peerTypesElsewhere(): Promise<void> {
  await act(async () => {
    pair?.peer.commands.setTextSelection(1);
    pair?.peer.commands.insertContent("peer ");
    pair?.sync();
  });
  await settle();
}

describe.each(OBJECTS)("%s wearing the ring", (_label, nodeType, object) => {
  beforeEach(async () => {
    pair = createCollabPair({
      type: "doc",
      content: [paragraph("before"), object, paragraph("after")],
    });
    await act(async () => {
      root?.render(<EditorContent editor={pair?.local ?? null} />);
    });
    // Guard the guard: without a React node view this file proves nothing.
    expect(pair.local.view.dom.querySelector(".react-renderer")).not.toBeNull();
  });

  it("keeps it through a peer's write elsewhere in the document", async () => {
    await selectObject(nodeType);
    expect(ringIsPainted()).toBe(true);

    await peerTypesElsewhere();

    expect(pair?.local.state.selection).toBeInstanceOf(NodeSelection);
    expect(ringIsPainted()).toBe(true);
  });

  it("is the only paint the object gains when it becomes selected", async () => {
    // One owner for selection visuals. A node view that derived its own border
    // from `NodeViewProps.selected` would paint a second one — and that prop's
    // lifecycle does not survive the rebuild a peer's write causes, so the two
    // disagree for a frame while the selection never changed.
    const before = [...objectElement(nodeType).classList].sort();

    await selectObject(nodeType);

    expect([...objectElement(nodeType).classList].sort()).toEqual(before);
    expect(pair?.local.view.dom.querySelectorAll(`.${SELECTED_OBJECT_CLASS}`)).toHaveLength(1);
  });

  it("still paints it when the writer selects the object again", async () => {
    await selectObject(nodeType);
    await peerTypesElsewhere();

    await act(async () => {
      pair?.local.commands.setTextSelection(1);
    });
    await settle();
    expect(ringIsPainted()).toBe(false);

    await selectObject(nodeType);
    expect(ringIsPainted()).toBe(true);
  });
});
