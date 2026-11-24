import { type RefObject, useEffect, useState } from "react";

export type ScrollEdges = { start: boolean; end: boolean };

export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const read = () => {
      const start = scroller.scrollLeft > 1;
      const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
      setEdges((was) => (was.start === start && was.end === end ? was : { start, end }));
    };
    const resize = new ResizeObserver(read);
    const observe = () => {
      resize.disconnect();
      resize.observe(scroller);
      for (const child of scroller.children) resize.observe(child);
      read();
    };
    observe();
    const added = new MutationObserver(observe);
    added.observe(scroller, { childList: true });
    scroller.addEventListener("scroll", read, { passive: true });
    return () => {
      resize.disconnect();
      added.disconnect();
      scroller.removeEventListener("scroll", read);
    };
  }, [ref]);
  return edges;
}
