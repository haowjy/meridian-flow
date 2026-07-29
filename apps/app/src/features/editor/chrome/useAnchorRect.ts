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
 */

import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

/** All four edges: a row hangs off the top-right, a hint off the bottom-left. */
export type AnchorRect = { top: number; right: number; bottom: number; left: number };

/**
 * Re-run `schedule` whenever the manuscript may have moved under `observed`,
 * coalesced to one call per frame. Returns the teardown.
 *
 * Four sources, and the transaction is the one a surface forgets: an element
 * that keeps its size and its identity still travels when a block above it
 * grows, when the writer moves it with Alt+Arrow, or when a peer's write lands
 * three paragraphs up. A ResizeObserver on the anchor sees none of those, so a
 * surface watching only itself paints over whatever slid into its old corner —
 * and an overlay is opaque and takes clicks, so a stale one eats the click the
 * writer aimed at the prose beneath it.
 *
 * The manuscript's own root is observed alongside the anchor for the layout
 * that changes with no transaction at all: a diagram finishing its render, an
 * image arriving, a font swapping. Those grow the document, and everything
 * below them moves without ever changing shape.
 */
export function watchManuscriptLayout(
  editor: Editor | null,
  observed: readonly (Element | null | undefined)[],
  schedule: () => void,
): () => void {
  let frame = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(schedule);
  };

  // Capture phase: the manuscript scrolls in a pane rather than the window, and
  // a surface has to travel with its block instead of hanging over whatever
  // paragraph took its place.
  window.addEventListener("scroll", run, true);
  window.addEventListener("resize", run);
  editor?.on("transaction", run);

  const observer = new ResizeObserver(run);
  const manuscript = editor && !editor.isDestroyed ? editor.view.dom : null;
  for (const element of [...observed, manuscript]) {
    if (element) observer.observe(element);
  }

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("scroll", run, true);
    window.removeEventListener("resize", run);
    editor?.off("transaction", run);
    observer.disconnect();
  };
}

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
