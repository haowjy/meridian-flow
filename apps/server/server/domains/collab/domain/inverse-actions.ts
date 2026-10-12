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
  consumptionEligible: (part: StoredInversePart) => boolean = () => true,
) {
  const effective = history.filter((part) => !isRolledBack(history, part));
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
  const actions = [...grouped]
    .map(([id, parts]) => {
      const consumed = new Set(
        effective
          .filter(
            (part) =>
              part.kind === "redo" && consumptionEligible(part) && part.consumes.includes(id),
          )
          .flatMap((part) => part.targets.map(partKey)),
      );
      const targets = new Set(
        parts
          .flatMap((part) => part.targets.map(partKey))
          .filter((key) => keys.has(key) && !consumed.has(key)),
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
