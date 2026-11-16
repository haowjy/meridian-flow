/**
 * Doing a planned move: one `move` record per row, appended to the browser's copy of the list the
 * destination belongs to. The rows show in their new place at once; a create the server drops comes
 * back as a `dropped` settlement and lands on the row as its failure mark. A row keeps its name:
 * beside a sibling of that name it is a twin. Results are data; selection belongs to the caller.
 */

import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { isAccountArea, type ReadyMove } from "./move-plan";

/** Move… and a drop both move rows here: one gesture in the list the destination belongs to. */
export function moveRows({ to, area, moves }: ReadyMove, actions: EntryActions): EntryRef[] {
  if (moves.length === 0) return [];
  (isAccountArea(area) ? actions.account : actions.project).moveAll(
    moves.map((row) => row.entry.id),
    to,
  );
  return moves.map((row) => row.entry);
}
