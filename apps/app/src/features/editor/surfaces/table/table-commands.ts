/**
 * Every table verb, and the one answer to "can it run here, and if not why".
 *
 * The grips make a selection; every verb reads that selection. That is the
 * whole model: clicking a row grip selects the row, so "delete row" is just
 * `deleteRow` over whatever is selected, and the same verb runs identically
 * from the menu, from a keyboard twin, and from a cell selection the writer
 * swept by hand. No verb takes a row index, so no verb can act on a row the
 * writer is not looking at.
 *
 * Availability is computed from the same command the item dispatches wherever
 * prosemirror-tables already answers it (`mergeCells`, `splitCell`), because a
 * control that looks live and does nothing is the dead control law 5 forbids.
 */

import type { Editor } from "@tiptap/core";
import type { Command, EditorState } from "@tiptap/pm/state";
import {
  addColumnAfter,
  addColumnBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  splitCell,
  TableMap,
  toggleHeaderRow,
} from "@tiptap/pm/tables";

import {
  addTableRow,
  alignTableColumn,
  hasHeaderRow,
  mergeJoinsCellText,
  mergeTableCells,
  moveTableColumn,
  moveTableRow,
  resetTableColumnWidths,
  setTablePlacement,
  tableHasSpans,
  tableSelection,
} from "@/core/editor/table-operations";

export type TableAlignment = "left" | "center" | "right";
export type TablePlacement = "left" | "center" | "right";

export const TABLE_VERB_IDS = [
  "insertRowAbove",
  "insertRowBelow",
  "moveRowUp",
  "moveRowDown",
  "deleteRow",
  "insertColumnLeft",
  "insertColumnRight",
  "moveColumnLeft",
  "moveColumnRight",
  "deleteColumn",
  "mergeCells",
  "splitCell",
  "alignLeft",
  "alignCenter",
  "alignRight",
  "headerRow",
  "placeLeft",
  "placeCenter",
  "placeRight",
  "resetColumnWidths",
  "deleteTable",
] as const;

export type TableVerbId = (typeof TABLE_VERB_IDS)[number];

export type TableBlockedReason =
  | "no-table"
  | "document-read-only"
  | "header-row-first"
  | "at-table-edge"
  | "merged-cells"
  | "single-row"
  | "single-column"
  | "one-cell-selected"
  | "cells-not-rectangular"
  | "not-merged"
  | "no-column-widths";

export type TableVerbState = {
  /** The verb's state is already applied (law 6: a toggle shows what it did). */
  active: boolean;
  /** Why it cannot run here. Null means it runs. */
  blockedBy: TableBlockedReason | null;
};

export type TableVerbStates = Record<TableVerbId, TableVerbState>;

const RUNS: TableVerbState = { active: false, blockedBy: null };

function blocked(reason: TableBlockedReason): TableVerbState {
  return { active: false, blockedBy: reason };
}

function everyVerb(state: TableVerbState): TableVerbStates {
  return Object.fromEntries(TABLE_VERB_IDS.map((id) => [id, state])) as TableVerbStates;
}

export const TABLE_VERB_COMMANDS: Record<TableVerbId, Command> = {
  insertRowAbove: addTableRow("above"),
  insertRowBelow: addTableRow("below"),
  moveRowUp: moveTableRow(-1),
  moveRowDown: moveTableRow(1),
  deleteRow,
  insertColumnLeft: addColumnBefore,
  insertColumnRight: addColumnAfter,
  moveColumnLeft: moveTableColumn(-1),
  moveColumnRight: moveTableColumn(1),
  deleteColumn,
  mergeCells: mergeTableCells,
  splitCell,
  alignLeft: alignTableColumn("left"),
  alignCenter: alignTableColumn("center"),
  alignRight: alignTableColumn("right"),
  headerRow: toggleHeaderRow,
  placeLeft: setTablePlacement(null),
  placeCenter: setTablePlacement("center"),
  placeRight: setTablePlacement("right"),
  resetColumnWidths: resetTableColumnWidths,
  deleteTable,
};

/**
 * The alignment every cell in the selected columns already carries, or null
 * when they disagree or none is set. Null is a real answer: a column with no
 * alignment renders in the reading direction and has not been decided, which
 * is different from a column decided to be left.
 */
export function selectedColumnAlignment(state: EditorState): TableAlignment | null {
  const selection = tableSelection(state);
  if (!selection) return null;

  const map = TableMap.get(selection.table);
  let shared: unknown;
  let first = true;
  for (const cellPos of map.cellsInRect({
    left: selection.columnFrom,
    right: selection.columnTo + 1,
    top: 0,
    bottom: map.height,
  })) {
    const alignment = selection.table.nodeAt(cellPos)?.attrs.alignment ?? null;
    if (first) {
      shared = alignment;
      first = false;
      continue;
    }
    if (shared !== alignment) return null;
  }

  return shared === "left" || shared === "center" || shared === "right" ? shared : null;
}

export { mergeJoinsCellText };

export function selectedTablePlacement(state: EditorState): TablePlacement {
  const align = tableSelection(state)?.table.attrs.align;
  return align === "center" || align === "right" ? align : "left";
}

/** How many cells the current selection covers. One means a bare caret in a cell. */
function selectedCellCount(state: EditorState): number {
  const { selection } = state;
  if (!(selection instanceof CellSelection)) return 1;
  let count = 0;
  selection.forEachCell(() => {
    count += 1;
  });
  return count;
}

/**
 * Every verb's state for the current selection.
 *
 * Read-only outranks every structural reason: on a document the writer cannot
 * change, saying so once is the honest answer.
 */
export function tableVerbStates(
  state: EditorState,
  { editable = true }: { editable?: boolean } = {},
): TableVerbStates {
  if (!editable) return everyVerb(blocked("document-read-only"));

  const selection = tableSelection(state);
  if (!selection) return everyVerb(blocked("no-table"));

  const { table, rowFrom, rowTo, columnFrom, columnTo } = selection;
  const map = TableMap.get(table);
  const header = hasHeaderRow(table);
  const spans = tableHasSpans(table);
  // A header row is structural where it exists: nothing goes above it, and it
  // does not travel. A headerless table has no such floor.
  const floor = header ? 1 : 0;
  const onHeader = rowFrom < floor;

  const rowMove = (blockedAtEdge: boolean): TableVerbState => {
    if (spans) return blocked("merged-cells");
    if (onHeader) return blocked("header-row-first");
    return blockedAtEdge ? blocked("at-table-edge") : RUNS;
  };
  const columnMove = (blockedAtEdge: boolean): TableVerbState => {
    if (spans) return blocked("merged-cells");
    return blockedAtEdge ? blocked("at-table-edge") : RUNS;
  };

  const cellCount = selectedCellCount(state);
  const alignment = selectedColumnAlignment(state);
  const placement = selectedTablePlacement(state);
  const hasWidths = resetTableColumnWidths(state, undefined);

  return {
    insertRowAbove: onHeader ? blocked("header-row-first") : RUNS,
    insertRowBelow: RUNS,
    moveRowUp: rowMove(rowFrom <= floor),
    moveRowDown: rowMove(rowTo >= map.height - 1),
    deleteRow: map.height <= 1 ? blocked("single-row") : RUNS,

    insertColumnLeft: RUNS,
    insertColumnRight: RUNS,
    moveColumnLeft: columnMove(columnFrom === 0),
    moveColumnRight: columnMove(columnTo >= map.width - 1),
    deleteColumn: map.width <= 1 ? blocked("single-column") : RUNS,

    mergeCells: mergeTableCells(state)
      ? RUNS
      : blocked(cellCount <= 1 ? "one-cell-selected" : "cells-not-rectangular"),
    splitCell: splitCell(state) ? RUNS : blocked("not-merged"),

    alignLeft: { active: alignment === "left", blockedBy: null },
    alignCenter: { active: alignment === "center", blockedBy: null },
    alignRight: { active: alignment === "right", blockedBy: null },

    headerRow: { active: header, blockedBy: null },
    placeLeft: { active: placement === "left", blockedBy: null },
    placeCenter: { active: placement === "center", blockedBy: null },
    placeRight: { active: placement === "right", blockedBy: null },
    resetColumnWidths: hasWidths ? RUNS : blocked("no-column-widths"),
    deleteTable: RUNS,
  };
}

/** Runs a verb and hands the caret back to the manuscript. */
export function runTableVerb(editor: Editor, id: TableVerbId): boolean {
  if (editor.isDestroyed) return false;
  const ran = TABLE_VERB_COMMANDS[id](editor.state, editor.view.dispatch, editor.view);
  editor.view.focus();
  return ran;
}

/** A resolved position standing immediately before a table cell, or null. */
function resolveCellBefore(state: EditorState, cellPos: number) {
  if (cellPos < 0 || cellPos > state.doc.content.size) return null;
  const $cell = state.doc.resolve(cellPos);
  const role = $cell.nodeAfter?.type.spec.tableRole;
  return role === "cell" || role === "header_cell" ? $cell : null;
}

/**
 * Select a whole row or column, which is what a grip press means before it
 * opens anything. Returns false when the cell left the document under it.
 */
export function selectTableAxis(editor: Editor, cellPos: number, axis: "row" | "column"): boolean {
  if (editor.isDestroyed) return false;
  const { state } = editor.view;
  const $cell = resolveCellBefore(state, cellPos);
  if (!$cell) return false;

  const selection =
    axis === "row" ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
  editor.view.dispatch(state.tr.setSelection(selection));
  return true;
}

/**
 * What the add tabs do: a new last row or last column, whatever the pointer
 * was over. They select the edge first so the insert is the same verb the
 * menu runs, rather than a second insertion path that could drift from it.
 */
export function appendTableAxis(editor: Editor, cellPos: number, axis: "row" | "column"): boolean {
  if (editor.isDestroyed) return false;
  const $cell = resolveCellBefore(editor.view.state, cellPos);
  if (!$cell) return false;

  const table = $cell.node(-1);
  const map = TableMap.get(table);
  const edgeCell = axis === "row" ? map.map[(map.height - 1) * map.width] : map.map[map.width - 1];
  if (!selectTableAxis(editor, $cell.start(-1) + edgeCell, axis)) return false;

  return runTableVerb(editor, axis === "row" ? "insertRowBelow" : "insertColumnRight");
}
