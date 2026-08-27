/** Shared controllable measurement seam for real toolbar adapter tests. */
import { useLayoutEffect, useRef } from "react";
import type { ComposerToolbarLayout } from "./composer-toolbar-layout";

let inlineIds: readonly string[] | "all" = "all";

export function setTestToolbarInlineIds(next: readonly string[] | "all") {
  inlineIds = next;
}

export function useTestMeasuredComposerToolbar(
  controls: readonly { id: string; priority: number }[],
  onLayout: (layout: ComposerToolbarLayout) => void,
) {
  const root = useRef<HTMLFieldSetElement | null>(null);
  const probe = useRef<HTMLButtonElement | null>(null);
  const controlIds = controls.map(({ id }) => id);
  const nextInlineIds =
    inlineIds === "all" ? controlIds : controlIds.filter((id) => inlineIds.includes(id));
  const revision = nextInlineIds.join("\0");
  useLayoutEffect(() => {
    const overflowIds = controlIds.filter((id) => !nextInlineIds.includes(id));
    onLayout({
      inlineIds: [...nextInlineIds],
      overflowIds,
      constrained: overflowIds.length > 0,
    });
  }, [revision, controls, onLayout]);
  return { root, probe, controlRef: () => () => {} };
}
