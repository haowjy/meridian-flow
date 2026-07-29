// @vitest-environment jsdom
/**
 * The margin handle stays on its block when the manuscript moves under a
 * pointer that did not.
 *
 * Scroll is the case a surface forgets: the writer's hand is still, the
 * document has not changed, and every signal a local watcher listens for —
 * a transaction, a window resize — stays silent while the block travels. A
 * handle measured once and left there strands beside whatever paragraph took
 * its place, which is the reported defect this suite holds shut.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { BlockMovementSurface } = await import("./BlockMovementSurface");

installJsdomLayout();

/** Where the second paragraph starts before anything scrolls. */
const SECOND_BLOCK_TOP = 140;
const BLOCK_HEIGHT = 40;
/** `blockHandlePosition`'s fallback lead when the line height is unreadable. */
const HANDLE_LEAD = 4;

let editor: Editor;
let root: Root;
let container: HTMLElement;
let scrollTop = 0;

/** Inert on purpose: only the scroll may be what re-measures here. */
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function rectOf(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 800,
    height,
    top,
    right: 800,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Give the manuscript a layout jsdom will not: three stacked blocks that all
 * move together when `scrollTop` does, exactly as a scrolling pane moves them.
 */
function layOutManuscript(): void {
  const { dom } = editor.view;
  dom.getBoundingClientRect = () => rectOf(0, 2000);
  for (const [index, child] of [...dom.children].entries()) {
    child.getBoundingClientRect = () =>
      rectOf(100 + index * BLOCK_HEIGHT - scrollTop, BLOCK_HEIGHT);
  }
}

/** The pointer comes to rest over the second paragraph and stays there. */
function hoverSecondBlock(): void {
  const pointer = new MouseEvent("pointermove", {
    bubbles: true,
    clientX: 40,
    clientY: SECOND_BLOCK_TOP + 10,
  });
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  editor.view.dom.dispatchEvent(pointer);
}

async function settle(ms = 160): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function handleTop(): number | null {
  const handle = document.querySelector<HTMLElement>("[data-block-handle]");
  return handle ? Number.parseFloat(handle.style.top) : null;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", SilentResizeObserver);
  scrollTop = 0;

  const host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
        { type: "paragraph", content: [{ type: "text", text: "third" }] },
      ],
    } satisfies JSONContent,
  });
  layOutManuscript();
  // jsdom has no layout, so the one browser reading the approach depends on is
  // stubbed at its own boundary: the pointer rests inside the second block.
  editor.view.posAtCoords = () => ({ pos: 9, inside: 8 });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  editor.destroy();
  vi.unstubAllGlobals();
});

it("keeps the handle on its block when the manuscript scrolls under a still pointer", async () => {
  act(() => root.render(<BlockMovementSurface editor={editor} />));
  hoverSecondBlock();
  await settle();

  expect(handleTop()).toBe(SECOND_BLOCK_TOP + HANDLE_LEAD);

  // The writer scrolls without moving the pointer. No transaction, no resize:
  // only the pane moved, and the block went with it.
  scrollTop = 120;
  act(() => {
    editor.view.dom.dispatchEvent(new Event("scroll"));
  });
  await settle(40);

  expect(handleTop()).toBe(SECOND_BLOCK_TOP - 120 + HANDLE_LEAD);
});
