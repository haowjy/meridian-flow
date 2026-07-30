// @vitest-environment jsdom
/**
 * An anchored surface follows its block when the DOCUMENT moves it.
 *
 * The observers a floating surface reaches for first — a ResizeObserver on the
 * anchor, a scroll listener — all report a change to the anchor itself, and a
 * block that travels because something above it changed reports none of them:
 * same element, same size, new place. That is the case this suite holds, which
 * is why nothing here ever fires a ResizeObserver (the shared jsdom fallback's
 * is inert, which is an unlaid-out document's honest answer). A rect that
 * changes came from the editor's transaction and nothing else.
 *
 * The measurement is one animation frame behind that transaction, so the frame
 * is driven by hand: a real one is a race the assertion would sometimes win.
 */
import type { JSONContent } from "@tiptap/core";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

import { type AnchorRect, useAnchorRect } from "./useAnchorRect";

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
  anchorTop = 100;
  anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ top: anchorTop, right: 800, bottom: anchorTop + 200, left: 300 }) as DOMRect;
  document.body.append(anchor);

  page = createReactEditorFixture({
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }],
    } satisfies JSONContent,
  });
  frames = createFrameClock();
});

afterEach(() => {
  page.destroy();
  reported = null;
  vi.unstubAllGlobals();
});

it("re-measures when a transaction moves the anchor's block", async () => {
  page.render(<Probe />);
  expect(reported).toEqual({ top: 100, right: 800, bottom: 300, left: 300 });

  // A paragraph typed above pushes the anchored block down. Nothing about the
  // element changed: not its identity, not its size, not the scroll position.
  anchorTop = 340;
  act(() => {
    page.editor.commands.insertContentAt(0, "<p>a new line above</p>");
  });
  await frames.flush();

  expect(reported).toEqual({ top: 340, right: 800, bottom: 540, left: 300 });
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
