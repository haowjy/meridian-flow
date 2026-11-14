/**
 * Doing a planned move: one `move` record per row, appended to the browser's copy of the list the
 * row's tree belongs to. The row shows in its new place at once; a server refusal comes back as a
 * `refused` settlement and lands on the row as its failure mark with Move… to repair. A name that
 * clashes is numbered by the replay, so the move needs no name; `renamesOnArrival` only predicts
 * it, for the warning shown before the drop. Results are data; selection belongs to the caller.
 */

import { allocateContextEntryArrivalName } from "../context-entry-name";
import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { isAccountArea, type MoveRow } from "./move-plan";

export type MoveResult = {
  /** Rows the list took. */
  moved: readonly EntryRef[];
  /** Rows no list could take (read-only, or the list is not open). */
  failed: readonly { entry: EntryRef; name: string }[];
};

/**
 * The rows a move would rename on arrival, for the warning shown before it happens. Each
 * destination's names are indexed once; a row's name is reserved once it arrives, so the next
 * row sees it (two `Notes` folders become `Notes (2)` and `Notes (3)`).
 */
export function renamesOnArrival(rows: readonly MoveRow[]): { name: string; as: string }[] {
  const occupied = new Map<string, Set<string>>();
  const staying = new Set(
    rows.filter((row) => row.from === row.to.parentId).map((row) => row.entry.id),
  );
  const occupancy = (row: MoveRow) => {
    let names = occupied.get(row.to.parentId);
    if (!names) {
      names = new Set(
        row.area.tree
          .children(row.to.parentId)
          .filter((entry) => !staying.has(entry.entryId))
          .map((entry) => entry.name),
      );
      occupied.set(row.to.parentId, names);
    }
    return names;
  };
  return rows.flatMap((row) => {
    const names = occupancy(row);
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

/** Move… and a drop both move rows here. */
export function moveRows(rows: readonly MoveRow[], actions: EntryActions): MoveResult {
  const moved: EntryRef[] = [];
  const failed: { entry: EntryRef; name: string }[] = [];
  for (const row of rows) {
    const list = isAccountArea(row.area) ? actions.account : actions.project;
    const result = list.move(row.entry.id, row.to.parentId, row.to.index);
    if (result.ok) moved.push(row.entry);
    else failed.push({ entry: row.entry, name: row.name });
  }
  return { moved, failed };
}
