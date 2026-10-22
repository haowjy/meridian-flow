// Effective immutable action history shared by card and model selectors.
import { type StoredTreeEntry, treeKey } from "./tree-inverse.js";
import type { StoredInversePart } from "./turn-inverse-service.js";

/** A text part keys by its ordinal; a tree entry, or a target naming one, by `:tree`. */
export const partKey = (part: { editId: string; ordinal?: number }) =>
  part.ordinal === undefined ? treeKey(part.editId) : `${part.editId}:${part.ordinal}`;

/** One row of the action index: a text part or a tree entry, ordered by `id` on one axis. */
type HistoryRow = StoredInversePart | StoredTreeEntry;
const rowKey = (row: HistoryRow) => ("tree" in row ? treeKey(row.editId) : partKey(row));

export function isRolledBack(history: readonly StoredInversePart[], part: StoredInversePart) {
  return history.some(
    (transition) =>
      transition.kind === "rollback" &&
      transition.targets.some((target) => partKey(target) === partKey(part)),
  );
}

/** Consumption is per accepted part, and a rolled-back action has no stack effect. */
export function effectiveActionIndex<Row extends HistoryRow>(
  history: readonly Row[],
  keys: ReadonlySet<string>,
) {
  const rolledBack = new Set(
    history.filter((part) => part.kind === "rollback").flatMap((part) => part.targets.map(partKey)),
  );
  const effective = history.filter((part) => !rolledBack.has(rowKey(part)));
  const grouped = new Map<string, Row[]>();
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
