import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  type ComposerToolbarLayout,
  resolveComposerToolbarLayout,
} from "./composer-toolbar-layout";
import type { ComposerToolbarControl } from "./types";

const same = (a: ComposerToolbarLayout, b: ComposerToolbarLayout) =>
  a.constrained === b.constrained &&
  a.inlineIds.join("\0") === b.inlineIds.join("\0") &&
  a.overflowIds.join("\0") === b.overflowIds.join("\0");

export function useMeasuredComposerToolbar(controls: readonly ComposerToolbarControl[]) {
  const root = useRef<HTMLDivElement | null>(null);
  const probe = useRef<HTMLButtonElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [layout, setLayout] = useState<ComposerToolbarLayout>(() => ({
    inlineIds: [],
    overflowIds: controls.map(({ id }) => id),
    constrained: false,
  }));
  const measure = useCallback(() => {
    if (!root.current || !probe.current || root.current.clientWidth <= 0) return;
    const gap = Number.parseFloat(getComputedStyle(root.current).columnGap) || 0;
    const controlWidths = new Map(
      [...nodes.current].map(([id, node]) => [id, node.getBoundingClientRect().width]),
    );
    const next = resolveComposerToolbarLayout(controls, {
      available: root.current.clientWidth,
      gap,
      overflowTrigger: probe.current.getBoundingClientRect().width,
      controlWidths,
    });
    setLayout((current) => (same(current, next) ? current : next));
  }, [controls]);
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    if (probe.current) observer.observe(probe.current);
    for (const node of nodes.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);
  const controlRef = (id: string) => (node: HTMLElement | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  };
  return { root, probe, controlRef, layout };
}
