/**
 * Doing a planned move: one `move` record per row, appended to the browser's copy of the list the
 * row's tree belongs to. The row shows in its new place at once; a create the server drops comes
 * back as a `dropped` settlement and lands on the row as its failure mark. A row keeps its name:
 * beside a sibling of that name it is a twin. Results are data; selection belongs to the caller.
 */

import type { EntryRef } from "./entry";
import type { EntryActions } from "./entry-actions";
import { isAccountArea, type MoveRow } from "./move-plan";

/** Move… and a drop both move rows here: one gesture per list, so each row is placed among the siblings the rows before it left. */
export function moveRows(rows: readonly MoveRow[], actions: EntryActions): EntryRef[] {
  const moved: EntryRef[] = [];
  for (const list of [actions.account, actions.project]) {
    const mine = rows.filter(
      (row) => (isAccountArea(row.area) ? actions.account : actions.project) === list,
    );
    if (mine.length === 0) continue;
    list.moveAll(
      mine.map((row) => ({ node: row.entry.id, parentId: row.to.parentId, index: row.to.index })),
    );
    moved.push(...mine.map((row) => row.entry));
  }
  return moved;
}
