// Effective immutable action history shared by card and model selectors.
import type { StoredInversePart } from "./turn-inverse-service.js";

export const partKey = (part: { editId: string; ordinal: number }) =>
  `${part.editId}:${part.ordinal}`;

export function isRolledBack(history: readonly StoredInversePart[], part: StoredInversePart) {
  return history.some(
    (transition) =>
      transition.kind === "rollback" &&
      transition.targets.some((target) => partKey(target) === partKey(part)),
  );
}

/** Consumption is per accepted part, and a rolled-back action has no stack effect. */
export function effectiveActionIndex(
  history: readonly StoredInversePart[],
  keys: ReadonlySet<string>,
) {
  const rolledBack = new Set(
    history.filter((part) => part.kind === "rollback").flatMap((part) => part.targets.map(partKey)),
  );
  const effective = history.filter((part) => !rolledBack.has(partKey(part)));
  const grouped = new Map<string, StoredInversePart[]>();
  for (const part of effective) {
    if (
      part.kind !== "undo" ||
      !part.actionId ||
      !part.targets.some((target) => keys.has(partKey(target)))
    )
      continue;
    const parts = grouped.get(part.actionId) ?? [];
    parts.push(part);
    grouped.set(part.actionId, parts);
  }
  const consumption = new Map<string, Set<string>>();
  for (const part of effective) {
    if (part.kind !== "redo") continue;
    for (const id of part.consumes) {
      const targets = consumption.get(id) ?? new Set<string>();
      for (const target of part.targets) targets.add(partKey(target));
      consumption.set(id, targets);
    }
  }
  const actions = [...grouped]
    .map(([id, parts]) => {
      const consumed = consumption.get(id);
      const targets = new Set(
        parts
          .flatMap((part) => part.targets.map(partKey))
          .filter((key) => keys.has(key) && !consumed?.has(key)),
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
  return { actions, byPart, rolledBack };
}
