// Rollback facts shared by the model revert policy and failed-response rollback.
import type { StoredInversePart } from "./turn-inverse-service.js";

export const partKey = (part: { editId: string; ordinal: number }) =>
  `${part.editId}:${part.ordinal}`;

/** Keys of every part a rollback transition has already undone. */
export function rolledBackKeys(history: readonly StoredInversePart[]): Set<string> {
  return new Set(
    history.filter((part) => part.kind === "rollback").flatMap((part) => part.targets.map(partKey)),
  );
}

export function isRolledBack(history: readonly StoredInversePart[], part: StoredInversePart) {
  return rolledBackKeys(history).has(partKey(part));
}
