/**
 * Following an anchor: the measurement every inside-corner surface needs.
 *
 * Object rows and the code block's chip cluster are both fixed-positioned over
 * a block's top-right bounds with zero footprint (ruling 8, ruling 15), so
 * both need the same answer to the same question — where is that block right
 * now. Anchoring lives here once rather than in each lane, which is also why
 * the two surfaces cannot drift apart by a pixel.
 */

import { useLayoutEffect, useState } from "react";

export type AnchorRect = { top: number; right: number };

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
      setRect((previous) =>
        previous && previous.top === box.top && previous.right === box.right
          ? previous
          : { top: box.top, right: box.right },
      );
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
