/**
 * Following an anchor: the measurement every floating surface needs.
 *
 * Object rows, the code block's chip cluster, and a link's destination hint
 * are all fixed-positioned against something in the manuscript with zero
 * footprint (ruling 8, ruling 15), so all three need the same answer to the
 * same question: where is that thing right now. And the manuscript moves. It
 * scrolls in its own pane, it reflows when an image loads, it grows as a peer
 * types above. Anchoring is therefore a measurement that repeats, and it lives
 * here once rather than in each lane, which is also why the surfaces cannot
 * drift apart by a pixel.
 */

import { useLayoutEffect, useState } from "react";

/** All four edges: a row hangs off the top-right, a hint off the bottom-left. */
export type AnchorRect = { top: number; right: number; bottom: number; left: number };

/**
 * The anchor's viewport rect, followed while the caller is mounted.
 *
 * Scroll is watched in capture phase because the manuscript scrolls in a pane
 * rather than the window, and a surface has to travel with its block instead
 * of hanging over whatever paragraph took its place. Measurement is
 * rAF-coalesced and the state is identity-stable, so a scroll that does not
 * move this anchor costs no render.
 */
export function useAnchorRect(anchor: HTMLElement | null): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      const box = anchor.getBoundingClientRect();
      setRect((previous) => (previous && sameRect(previous, box) ? previous : boxOf(box)));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [anchor]);

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
