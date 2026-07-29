// @vitest-environment jsdom
/**
 * An anchored surface follows its block when the DOCUMENT moves it.
 *
 * The observers a floating surface reaches for first — a ResizeObserver on the
 * anchor, a scroll listener — all report a change to the anchor itself, and a
 * block that travels because something above it changed reports none of them:
 * same element, same size, new place. That is the case this suite holds, which
 * is why the ResizeObserver here is deliberately inert. A rect that survives it
 * came from the editor's transaction and nothing else.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

import { type AnchorRect, useAnchorRect } from "./useAnchorRect";

installJsdomLayout();

let editor: Editor;
let root: Root;
let container: HTMLElement;
let anchor: HTMLElement;
let anchorTop = 0;
let reported: AnchorRect | null = null;

/** Inert on purpose: only the transaction may be what re-measures here. */
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Probe() {
  reported = useAnchorRect(editor, anchor);
  return null;
}

/** Two frames: one for the rAF the watcher coalesces into, one for the render. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", SilentResizeObserver);

  anchorTop = 100;
  anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ top: anchorTop, right: 800, bottom: anchorTop + 200, left: 300 }) as DOMRect;
  document.body.append(anchor);

  const host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }],
    } satisfies JSONContent,
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  anchor.remove();
  editor.destroy();
  reported = null;
  vi.unstubAllGlobals();
});

it("re-measures when a transaction moves the anchor's block", async () => {
  act(() => root.render(<Probe />));
  expect(reported).toEqual({ top: 100, right: 800, bottom: 300, left: 300 });

  // A paragraph typed above pushes the anchored block down. Nothing about the
  // element changed: not its identity, not its size, not the scroll position.
  anchorTop = 340;
  act(() => {
    editor.commands.insertContentAt(0, "<p>a new line above</p>");
  });
  await settle();

  expect(reported).toEqual({ top: 340, right: 800, bottom: 540, left: 300 });
});

it("reports no rect once the anchor has left the document", async () => {
  act(() => root.render(<Probe />));
  expect(reported).not.toBeNull();

  // What a remounting node view leaves behind. A detached element measures as a
  // zero box in the top-left corner, and an overlay drawn there would be opaque
  // and clickable over whatever the writer keeps in that corner.
  anchor.remove();
  act(() => {
    editor.commands.insertContentAt(0, "<p>a new line above</p>");
  });
  await settle();

  expect(reported).toBeNull();
});
