// @vitest-environment jsdom
/**
 * The margin handle answers for the block under the pointer, and for no other.
 *
 * Scroll is the case a hover surface forgets: the writer's hand is still, the
 * document has not changed, and the block travels anyway. Two things have to
 * follow it — the measurement, so the handle never stands where its block used
 * to be, and the TARGET, so a handle beside a paragraph that scrolled away
 * either moves to the paragraph now there or leaves.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CHROME_TIMING, getEditorChrome } from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));

const { BlockMovementSurface } = await import("./BlockMovementSurface");

installJsdomLayout();

/** Three blocks 40 tall, 20 apart, the first starting at 100. */
const FIRST_BLOCK_TOP = 100;
const BLOCK_HEIGHT = 40;
const BLOCK_PITCH = 60;
/** Ten pixels into the second block, and it never moves. */
const POINTER_Y = FIRST_BLOCK_TOP + BLOCK_PITCH + 10;
/** `blockHandlePosition`'s fallback lead when the line height is unreadable. */
const HANDLE_LEAD = 4;

let editor: Editor;
let root: Root;
let container: HTMLElement;
let host: HTMLElement;
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

/** Which block a viewport y falls in, or null in the seam between two. */
function blockIndexAt(clientY: number): number | null {
  const documentY = clientY + scrollTop - FIRST_BLOCK_TOP;
  const index = Math.floor(documentY / BLOCK_PITCH);
  if (index < 0 || index >= editor.state.doc.childCount) return null;
  return documentY - index * BLOCK_PITCH <= BLOCK_HEIGHT ? index : null;
}

function blockElementAt(index: number): Element {
  return editor.view.dom.children[index];
}

/**
 * Give the manuscript a layout jsdom will not, plus the two browser readings
 * the approach depends on: what is at a point, and where that point is in the
 * document. Both move with `scrollTop`, exactly as a scrolling pane moves them.
 */
function layOutManuscript(): void {
  const { dom } = editor.view;
  dom.getBoundingClientRect = () => rectOf(0, 2000);
  for (const [index, child] of [...dom.children].entries()) {
    child.getBoundingClientRect = () =>
      rectOf(FIRST_BLOCK_TOP + index * BLOCK_PITCH - scrollTop, BLOCK_HEIGHT);
  }

  document.elementFromPoint = (_x: number, y: number) => {
    const index = blockIndexAt(y);
    return index === null ? dom : blockElementAt(index);
  };
  editor.view.posAtCoords = ({ top }) => {
    const index = blockIndexAt(top);
    if (index === null) return null;
    let pos = 0;
    for (let before = 0; before < index; before += 1)
      pos += editor.state.doc.child(before).nodeSize;
    return { pos: pos + 1, inside: pos };
  };
}

/** The pointer comes to rest over the second block and stays there. */
function restPointer(): void {
  const pointer = new MouseEvent("pointermove", {
    bubbles: true,
    clientX: 40,
    clientY: POINTER_Y,
  });
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  editor.view.dom.dispatchEvent(pointer);
}

/** Scroll the pane by `distance`, with no pointer event and no transaction. */
function scrollPane(distance: number): void {
  scrollTop = distance;
  act(() => {
    editor.view.dom.dispatchEvent(new Event("scroll"));
  });
}

/** One animation frame on the fake clock, which is what the scheduler uses. */
const FRAME_MS = 16;

/**
 * Run the clock inside `act`, so what a timer or a frame changed is committed
 * before the next step. Every wait in this file is one of the editor's own
 * clocks — the kernel's hover delay and the frame the shared layout watcher
 * coalesces onto — rather than wall time, so a longer debounce cannot make a
 * behaviourally unchanged surface fail here.
 */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Two frames: the measurement is one, the render it caused is the next. */
function flushMeasurement(): void {
  advance(FRAME_MS * 2);
}

/** The hover delay the kernel makes a cold pointer earn, then the measurement. */
function settleApproach(): void {
  advance(CHROME_TIMING.handleIntentMs);
  flushMeasurement();
}

function handleTop(): number | null {
  const handle = document.querySelector<HTMLElement>("[data-block-handle]");
  return handle ? Number.parseFloat(handle.style.top) : null;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Frames on the same clock as the timers: the approach waits on a timeout and
  // the placement waits on a frame, so one clock drives the whole surface.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  vi.stubGlobal("ResizeObserver", SilentResizeObserver);
  scrollTop = 0;

  host = document.createElement("div");
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

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  editor.destroy();
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps the handle on its block when the manuscript scrolls under a still pointer", () => {
  act(() => root.render(<BlockMovementSurface editor={editor} />));
  restPointer();
  settleApproach();
  expect(handleTop()).toBe(FIRST_BLOCK_TOP + BLOCK_PITCH + HANDLE_LEAD);

  // Twenty pixels: the same block is still under the pointer, further up.
  scrollPane(20);
  flushMeasurement();

  expect(handleTop()).toBe(FIRST_BLOCK_TOP + BLOCK_PITCH - 20 + HANDLE_LEAD);
});

it("re-targets when another block slides under the still pointer", () => {
  act(() => root.render(<BlockMovementSurface editor={editor} />));
  restPointer();
  settleApproach();

  // Eighty pixels: the third block is now where the second one was, and the
  // handle belongs to what the pointer is on rather than to what it was on.
  scrollPane(80);
  flushMeasurement();

  expect(handleTop()).toBe(FIRST_BLOCK_TOP + 2 * BLOCK_PITCH - 80 + HANDLE_LEAD);
});

/**
 * Escape during a drag is the kernel's step, not this surface's.
 *
 * The visible result is the same either way — the walk home cancels a gesture
 * before anything else — so the assertion is on the ROUTE: `beginDrag(onCancel)`
 * is the door Esc reaches a surface-owned drag through, and the chain is what
 * knocks on it. A surface that cancelled itself from a window listener would
 * pass a test that only looked at the drop line, while the registered chain
 * neither owned nor observed the step.
 */
it("hands an off-prose Escape to the kernel, which cancels the drag through its own door", () => {
  act(() => root.render(<BlockMovementSurface editor={editor} />));
  restPointer();
  settleApproach();

  const chrome = getEditorChrome(editor);
  if (!chrome) throw new Error("kernel did not mount");

  const cancelledByKernel = vi.fn();
  const beginDrag = chrome.beginDrag.bind(chrome);
  vi.spyOn(chrome, "beginDrag").mockImplementation((onCancel) =>
    beginDrag(() => {
      cancelledByKernel();
      onCancel?.();
    }),
  );

  const handle = document.querySelector<HTMLElement>("[data-block-handle]");
  if (!handle) throw new Error("the handle never appeared");
  act(() => {
    handle.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: POINTER_Y,
      }),
    );
  });
  // Past the slop, so the press is a drag the kernel knows about.
  act(() => {
    window.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: POINTER_Y + 30 }),
    );
  });
  expect(chrome.gesture).toBe("drag");

  // The press began on the handle, which is portalled out of the prose, so the
  // key lands on chrome rather than on ProseMirror.
  act(() => {
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(cancelledByKernel).toHaveBeenCalledOnce();
  expect(chrome.gesture).toBe("idle");
  expect(document.querySelector(".meridian-block-drop-line")).toBeNull();
});
