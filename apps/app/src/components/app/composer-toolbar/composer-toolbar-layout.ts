import type { ComposerToolbarControl } from "./types";

export type ComposerToolbarMetrics = {
  available: number;
  gap: number;
  overflowTrigger: number;
  controlWidths: ReadonlyMap<string, number>;
};

export type ComposerToolbarLayout = {
  inlineIds: readonly string[];
  overflowIds: readonly string[];
  constrained: boolean;
};

export function resolveComposerToolbarLayout(
  controls: readonly Pick<ComposerToolbarControl, "id" | "priority" | "overflow">[],
  metrics: ComposerToolbarMetrics,
): ComposerToolbarLayout {
  const ids = new Set(controls.map(({ id }) => id));
  if (ids.size !== controls.length) throw new Error("Composer toolbar control IDs must be unique");
  const width = (id: string) => metrics.controlWidths.get(id) ?? 0;
  const fits = (visible: readonly string[], overflow: boolean) => {
    const total = visible.reduce((sum, id) => sum + width(id), 0);
    return (
      total +
        (overflow
          ? metrics.overflowTrigger + metrics.gap * visible.length
          : metrics.gap * Math.max(0, visible.length - 1)) <=
      metrics.available + 0.5
    );
  };
  const sourceIds = controls.map(({ id }) => id);
  if (fits(sourceIds, false)) return { inlineIds: sourceIds, overflowIds: [], constrained: false };
  const eviction = controls
    .map((control, index) => ({ ...control, index }))
    .sort((a, b) => a.priority - b.priority || b.index - a.index);
  const hidden = new Set<string>();
  for (const control of eviction) {
    hidden.add(control.id);
    const visible = sourceIds.filter((id) => !hidden.has(id));
    if (fits(visible, true))
      return {
        inlineIds: visible,
        overflowIds: sourceIds.filter((id) => hidden.has(id)),
        constrained: false,
      };
  }
  return {
    inlineIds: [],
    overflowIds: sourceIds,
    constrained: metrics.overflowTrigger > metrics.available + 0.5,
  };
}
