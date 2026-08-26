/** Virtualizes a list in an existing scroll owner and owns its coordinate geometry. */
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useExternalScrollVirtualList<T>({
  items,
  scrollOwner,
  getItemKey,
  estimateSize,
  overscan = 8,
}: {
  items: readonly T[];
  scrollOwner: React.RefObject<HTMLElement | null>;
  getItemKey: (item: T) => React.Key;
  estimateSize: () => number;
  overscan?: number;
}) {
  const [list, setList] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIds, setActiveIds] = useState<Set<React.Key>>(() => new Set());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useLayoutEffect(() => {
    const owner = scrollOwner.current;
    if (!list || !owner) return;
    const measure = () =>
      setScrollMargin(
        list.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(owner);
    let node: HTMLElement | null = list;
    while (node && node !== owner) {
      observer.observe(node);
      node = node.parentElement;
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [list, scrollOwner]);

  const onActiveChange = useCallback((id: React.Key, active: boolean) => {
    setActiveIds((current) => {
      if (current.has(id) === active) return current;
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const id of activeIds) {
        const index = itemsRef.current.findIndex((item) => getItemKey(item) === id);
        if (index >= 0) indexes.add(index);
      }
      return [...indexes].sort((a, b) => a - b);
    },
    [activeIds, getItemKey],
  );
  const itemKey = useCallback(
    (index: number) => {
      const item = itemsRef.current[index];
      return item === undefined ? index : getItemKey(item);
    },
    [getItemKey],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollOwner.current,
    estimateSize,
    getItemKey: itemKey,
    overscan,
    scrollMargin,
    rangeExtractor,
  });
  return { listRef: setList, onActiveChange, virtualizer };
}
