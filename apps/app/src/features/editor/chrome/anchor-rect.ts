/**
 * Where a piece of chrome's anchor is right now, followed while it is mounted.
 *
 * Every overlay in the editor hangs off something in the manuscript — an
 * object, a link, a grip — and the manuscript moves: it scrolls in its own
 * pane, it reflows when an image loads, it grows as a peer types above. So
 * anchoring is a measurement that repeats, not one taken at reveal time.
 *
 * Scroll is watched in capture phase because the manuscript scrolls in a pane
 * rather than the window, and a `ResizeObserver` covers the anchor changing
 * shape under a fixed scroll position.
 */

import { useLayoutEffect, useState } from "react";

export type AnchorRect = { top: number; right: number; bottom: number; left: number };

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
