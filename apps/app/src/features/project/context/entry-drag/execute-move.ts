import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { isAccountArea, type ReadyMove } from "./move-plan";

export function moveRows({ to, area, moves }: ReadyMove, actions: EntryActions): EntryRef[] {
  if (moves.length === 0) return [];
  (isAccountArea(area) ? actions.account : actions.project).moveAll(
    moves.map((row) => row.entry.id),
    to,
  );
  return moves.map((row) => row.entry);
}
