/**
 * Following an anchor: the measurement every floating surface needs.
 *
 * Object rows, the code block's chip cluster, and a link's destination hint
 * are all fixed-positioned against something in the manuscript with zero
 * footprint (ruling 8, ruling 15), so all three need the same answer to the
 * same question: where is that thing right now. And the manuscript moves. It
 * scrolls in its own pane, it reflows when an image loads, it grows as a peer
 * types above, and a block the writer moves takes every block after it along.
 * Anchoring is therefore a measurement that repeats, and it lives here once
 * rather than in each lane, which is also why the surfaces cannot drift apart
 * by a pixel.
 *
 * WHEN to repeat it is the kernel's `watchManuscriptLayout`, shared with the
 * approach's own re-hit-testing so the two can never fall out of step.
 */

import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

import { watchManuscriptLayout } from "@/core/editor/chrome";

/** All four edges: a row hangs off the top-right, a hint off the bottom-left. */
export type AnchorRect = { top: number; right: number; bottom: number; left: number };

/**
 * The anchor's viewport rect, followed while the caller is mounted.
 *
 * Null once the anchor has left the document: a node view that remounts leaves
 * the old element detached, and a detached element measures as a zero box in
 * the page's top-left corner. Reporting no rect takes the surface off the page
 * instead, which is the honest answer — the thing it decorated is gone — and
 * keeps an opaque overlay from taking clicks in a corner it never belonged in.
 *
 * Measurement is rAF-coalesced and the state is identity-stable, so a scroll
 * or a keystroke that does not move this anchor costs no render.
 */
export function useAnchorRect(
  editor: Editor | null,
  anchor: HTMLElement | null,
): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }

    const measure = () => {
      const box = anchor.isConnected ? anchor.getBoundingClientRect() : null;
      setRect((previous) => {
        if (!box) return null;
        return previous && sameRect(previous, box) ? previous : boxOf(box);
      });
    };

    measure();
    return watchManuscriptLayout(editor, [anchor], measure);
  }, [anchor, editor]);

  return rect;
}

function boxOf({ top, right, bottom, left }: DOMRect): AnchorRect {
  return { top, right, bottom, left };
}

function sameRect(rect: AnchorRect, box: DOMRect): boolean {
  return (
    rect.top === box.top &&
    rect.right === box.right &&
    rect.bottom === box.bottom &&
    rect.left === box.left
  );
}
