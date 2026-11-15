// Effective immutable action history shared by card and model selectors.
import type { StoredInversePart } from "./turn-inverse-service.js";

/** A text part keys by its edit and ordinal. */
export const partKey = (part: { editId: string; ordinal: number }) =>
  `${part.editId}:${part.ordinal}`;

/** The undo and writer-revert actions that took each of `keys`' parts back. */
export function effectiveActionIndex(
  history: readonly StoredInversePart[],
  keys: ReadonlySet<string>,
) {
  const grouped = new Map<string, StoredInversePart[]>();
  for (const part of history) {
    if (
      (part.kind !== "undo" && !(part.kind === "revert" && part.actor === "human")) ||
      !part.actionId ||
      !part.targets.some((target) => keys.has(partKey(target)))
    )
      continue;
    const parts = grouped.get(part.actionId) ?? [];
    parts.push(part);
    grouped.set(part.actionId, parts);
  }
  const actions = [...grouped]
    .map(([id, parts]) => {
      const targets = new Set(
        parts.flatMap((part) => part.targets.map(partKey)).filter((key) => keys.has(key)),
      );
      return { id, parts, targets, newest: Math.max(...parts.map((part) => part.id)) };
    })
    .filter((action) => action.targets.size)
    .sort((a, b) => b.newest - a.newest);
  const byPart = new Map<string, (typeof actions)[number][]>();
  for (const action of actions)
    for (const target of action.targets) {
      const accepted = byPart.get(target) ?? [];
      accepted.push(action);
      byPart.set(target, accepted);
    }
  return { actions, byPart };
}
