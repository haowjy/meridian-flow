// @vitest-environment jsdom
/**
 * An anchored surface follows its block when the DOCUMENT moves it, and
 * answers in the pane's coordinates rather than the window's.
 *
 * The observers a floating surface reaches for first — a ResizeObserver on the
 * anchor, a scroll listener — all report a change to the anchor itself, and a
 * block that travels because something above it changed reports none of them:
 * same element, same size, new place. That is the case this suite holds, which
 * is why nothing here ever fires a ResizeObserver (the shared jsdom fallback's
 * is inert, which is an unlaid-out document's honest answer). A rect that
 * changes came from the editor's transaction and nothing else.
 *
 * The pane is given an origin of its own — offset in the window, bordered, and
 * already scrolled — because the numbers this hook returns are what a surface
 * is placed at INSIDE it. With a pane at the window's own origin the
 * conversion is the identity, and a suite asserting window numbers would pass
 * against a hook that had never learned to convert.
 *
 * The measurement is one animation frame behind that transaction, so the frame
 * is driven by hand: a real one is a race the assertion would sometimes win.
 */
import type { JSONContent } from "@tiptap/core";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

import { manuscriptOverlay } from "./manuscript-overlay";
import { type AnchorRect, useAnchorRect } from "./useAnchorRect";

/** Where the pane sits in the window, how thick its border is, how far it has scrolled. */
const PANE_LEFT = 20;
const PANE_TOP = 40;
const PANE_BORDER = 2;
const PANE_SCROLL_TOP = 60;

type FrameClock = { flush: () => Promise<void> };

let page: ReactEditorFixture;
let frames: FrameClock;
let anchor: HTMLElement;
let anchorTop = 0;
let reported: AnchorRect | null = null;

/** The frame the layout watcher coalesces into, ended when the test says so. */
function createFrameClock(): FrameClock {
  const pending = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    pending.delete(handle);
  });
  return {
    flush: async () => {
      const due = [...pending.values()];
      pending.clear();
      await act(async () => {
        for (const callback of due) callback(0);
      });
    },
  };
}

function Probe() {
  reported = useAnchorRect(page.editor, anchor);
  return null;
}

beforeEach(() => {
  page = createReactEditorFixture({
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }],
    } satisfies JSONContent,
  });

  const pane = manuscriptOverlay(page.editor);
  if (!pane) throw new Error("the harness mounted no manuscript pane");
  pane.getBoundingClientRect = () =>
    ({ top: PANE_TOP, right: 820, bottom: 640, left: PANE_LEFT }) as DOMRect;
  Object.defineProperties(pane, {
    clientLeft: { value: PANE_BORDER, configurable: true },
    clientTop: { value: PANE_BORDER, configurable: true },
    scrollLeft: { value: 0, configurable: true },
    // jsdom lays nothing out, so its own `scrollTop` setter is a no-op: an
    // own property is the only way to say the pane has been scrolled.
    scrollTop: { value: PANE_SCROLL_TOP, configurable: true },
  });

  // In the pane, where a real anchor is. Appended to the body it would still
  // measure, and the hook would still answer — against a pane it had never
  // been inside.
  anchorTop = 100;
  anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ top: anchorTop, right: 800, bottom: anchorTop + 200, left: 300 }) as DOMRect;
  pane.append(anchor);

  frames = createFrameClock();
});

afterEach(() => {
  page.destroy();
  reported = null;
  vi.unstubAllGlobals();
});

it("re-measures when a transaction moves the anchor's block", async () => {
  page.render(<Probe />);
  // The window's 300/100 read from a pane whose content origin is
  // (20 + 2 - 0, 40 + 2 - 60): 278 across, 118 down.
  expect(reported).toEqual({ top: 118, right: 778, bottom: 318, left: 278 });

  // A paragraph typed above pushes the anchored block down. Nothing about the
  // element changed: not its identity, not its size, not the scroll position.
  anchorTop = 340;
  act(() => {
    page.editor.commands.insertContentAt(0, "<p>a new line above</p>");
  });
  await frames.flush();

  expect(reported).toEqual({ top: 358, right: 778, bottom: 558, left: 278 });
});

it("reports no rect once the anchor has left the document", async () => {
  page.render(<Probe />);
  expect(reported).not.toBeNull();

  // What a remounting node view leaves behind. A detached element measures as a
  // zero box in the top-left corner, and an overlay drawn there would be opaque
  // and clickable over whatever the writer keeps in that corner.
  anchor.remove();
  act(() => {
    page.editor.commands.insertContentAt(0, "<p>a new line above</p>");
  });
  await frames.flush();

  expect(reported).toBeNull();
});
