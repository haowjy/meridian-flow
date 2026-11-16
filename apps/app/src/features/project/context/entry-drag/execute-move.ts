/**
 * Doing a planned move: one `move` record per row, appended to the browser's copy of the list the
 * destination belongs to. The rows show in their new place at once; a create the server drops comes
 * back as a `dropped` settlement and lands on the row as its failure mark. A name that
 * clashes is numbered by the writer and recorded with the move; `renamesOnArrival` predicts it,
 * for the warning shown before the drop. Results are data; selection belongs to the caller.
 */

import { allocateContextEntryArrivalName } from "../context-entry-name";
import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { isAccountArea, type ReadyMove } from "./move-plan";

/**
 * The rows a move would rename on arrival, for the warning shown before it happens. A row's name
 * is reserved once it arrives, so the next row sees it (two `Notes` folders become `Notes (2)`
 * and `Notes (3)`).
 */
export function renamesOnArrival({ to, area, moves }: ReadyMove): { name: string; as: string }[] {
  const staying = new Set(
    moves.filter((row) => row.from === to.parentId).map((row) => row.entry.id),
  );
  const names = new Set(
    area.tree
      .children(to.parentId)
      .filter((entry) => !staying.has(entry.entryId))
      .map((entry) => entry.name),
  );
  return moves.flatMap((row) => {
    const as = allocateContextEntryArrivalName(
      row.name,
      names,
      row.entry.kind === "folder" ? "folder" : "file",
      row.named,
    );
    names.add(as);
    return as !== row.name ? [{ name: row.name, as }] : [];
  });
}

/** Move… and a drop both move rows here: one gesture in the list the destination belongs to. */
export function moveRows({ to, area, moves }: ReadyMove, actions: EntryActions): EntryRef[] {
  if (moves.length === 0) return [];
  (isAccountArea(area) ? actions.account : actions.project).moveAll(
    moves.map((row) => row.entry.id),
    to,
  );
  return moves.map((row) => row.entry);
}
