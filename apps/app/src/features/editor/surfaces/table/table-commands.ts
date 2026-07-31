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
import type { ResolvedPos } from "@tiptap/pm/model";
import type { Command, EditorState, Selection } from "@tiptap/pm/state";
import {
  addColumnAfter,
  addColumnBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  splitCell,
  TableMap,
} from "@tiptap/pm/tables";

import { type NodeHold, resolveNodeHold } from "@/core/editor/anchors";
import {
  type ContextClaimTarget,
  getEditorChrome,
  isEditorChromeElement,
} from "@/core/editor/chrome";
import {
  addTableRow,
  alignTableColumn,
  hasHeaderRow,
  mergeCrossesHeader,
  mergeTableCells,
  moveTableColumn,
  moveTableRow,
  resetTableColumnWidths,
  setTablePlacement,
  tableHasSpans,
  tableSelection,
  toggleTableHeaderRow,
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
  | "header-and-body"
  | "not-merged"
  | "many-cells-selected"
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
  headerRow: toggleTableHeaderRow,
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

export function selectedTablePlacement(state: EditorState): TablePlacement {
  const align = tableSelection(state)?.table.attrs.align;
  return align === "center" || align === "right" ? align : "left";
}

/** Why a merge cannot run, in the order the writer would notice them. */
function mergeRefusal(state: EditorState, cellCount: number): TableBlockedReason {
  if (mergeCrossesHeader(state)) return "header-and-body";
  return cellCount <= 1 ? "one-cell-selected" : "cells-not-rectangular";
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

    mergeCells: mergeTableCells(state) ? RUNS : blocked(mergeRefusal(state, cellCount)),
    // Upstream refuses a multi-cell selection BEFORE it looks for a span, so
    // "this cell is not merged" would be a lie about a selection that contains
    // a merged cell.
    splitCell: splitCell(state)
      ? RUNS
      : blocked(cellCount > 1 ? "many-cells-selected" : "not-merged"),

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

/**
 * What a table menu acts on, held rather than read back from the selection.
 *
 * A menu outlives the arrangement that opened it, and that arrangement is the
 * one thing a remote write cannot carry: y-prosemirror restores the writer's
 * place as a caret, so the rectangle a writer swept has stopped being selected
 * by the time they reach "Merge cells". A target names its cells in terms only
 * their disappearance can change (`core/editor/anchors.ts`), and the selection
 * is materialized from it every time the menu is read or run.
 *
 * `selection` is the shape for the arrangements the writer is standing in — a
 * caret in a cell, a selected table. Nothing is held because there is nothing
 * to hold: that arrangement mounts the menu and unmounting it is how it ends.
 */
export type TableMenuTarget =
  /** A grip's row or column, named by the cell the grip serves. */
  | { kind: "axis"; cell: NodeHold; axis: "row" | "column" }
  /** A rectangle the writer swept, named by the two cells that describe it. */
  | { kind: "cells"; anchor: NodeHold; head: NodeHold }
  | { kind: "selection" };

/** Where a held cell stands now, or null once it is not that cell any more. */
function resolveHeldCell(state: EditorState, hold: NodeHold): ResolvedPos | null {
  const at = resolveNodeHold(state, hold);
  return at ? resolveCellBefore(state, at.from) : null;
}

/**
 * The selection the target describes in this state, or null once it is gone.
 *
 * Null is a whole answer: absent beats wrong, so a target that can no longer be
 * described closes its menu instead of aiming it at whatever the selection has
 * become.
 */
function targetSelection(state: EditorState, target: TableMenuTarget): Selection | null {
  if (target.kind === "selection") return state.selection;

  if (target.kind === "axis") {
    const $cell = resolveHeldCell(state, target.cell);
    if (!$cell) return null;
    return target.axis === "row"
      ? CellSelection.rowSelection($cell)
      : CellSelection.colSelection($cell);
  }

  const $anchor = resolveHeldCell(state, target.anchor);
  const $head = resolveHeldCell(state, target.head);
  // A rectangle is two cells of ONE table. Yjs replaces the element behind a
  // cell that really moved, so a pair that both resolve has not crossed into
  // another table — this is what says so rather than assuming it.
  if (!$anchor || !$head || $anchor.start(-1) !== $head.start(-1)) return null;
  return CellSelection.create(state.doc, $anchor.pos, $head.pos);
}

/**
 * The state a menu reads its verbs from: its own target, materialized. Null
 * once the target is gone, which is a menu with nothing left to offer.
 *
 * Applied rather than dispatched: what a verb WOULD do is a question, and
 * asking it must not move the writer's own selection.
 */
export function tableTargetState(editor: Editor, target: TableMenuTarget): EditorState | null {
  if (editor.isDestroyed) return null;
  const { state } = editor;
  if (target.kind === "selection") return state;
  const selection = targetSelection(state, target);
  return selection ? state.apply(state.tr.setSelection(selection)) : null;
}

/**
 * Run a verb on a menu's target: materialize the target, then run.
 *
 * Every verb still reads the selection — that is the whole model — and this is
 * what makes the selection it reads the one the writer opened the menu on,
 * however many peers have written since. False when the target is gone: the
 * menu closes on the same answer.
 */
export function runTableVerbOn(editor: Editor, target: TableMenuTarget, id: TableVerbId): boolean {
  if (editor.isDestroyed) return false;
  if (target.kind !== "selection") {
    const selection = targetSelection(editor.state, target);
    if (!selection) return false;
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  }
  return runTableVerb(editor, id);
}

/**
 * The pointer sits inside one of the cells the selection covers.
 *
 * Not the selection's `from`..`to` range: a rectangle two columns wide in a
 * four-column table spans cells it does not contain, and aiming at one of
 * those is not aiming at what was swept.
 */
function pointerInsideCellSelection(state: EditorState, docPos: number | null): boolean {
  const { selection } = state;
  if (docPos === null || !(selection instanceof CellSelection)) return false;

  let inside = false;
  selection.forEachCell((cell, pos) => {
    if (docPos >= pos && docPos <= pos + cell.nodeSize) inside = true;
  });
  return inside;
}

/**
 * The two cells a right-click on a swept rectangle opens a menu for, or null
 * when this right-click is not that. Synchronous by contract.
 *
 * A rectangle of cells is the one table selection no grip can make, and the
 * only path to merging two arbitrary cells. Nothing above this rung wants it:
 * the formatting menu admits `TextSelection` and `AllSelection` only, so
 * without this a writer who swept two cells and right-clicked got silence.
 *
 * A bare caret in a cell is NOT this: it falls to the ladder's `caret` rung,
 * where the formatting menu opens carrying the table's own lists.
 *
 * The cells rather than a boolean, because the claim is the last moment the
 * rectangle is on screen: the menu it opens has to hold what it acts on before
 * the next remote write turns the selection back into a caret.
 */
export function claimedSweptCells(
  editor: Editor,
  target: ContextClaimTarget,
): { anchor: number; head: number } | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { selection } = editor.state;
  if (!(selection instanceof CellSelection)) return null;
  if (!pointerInsideCellSelection(editor.state, target.docPos)) return null;
  // A grip or an overlay row standing over the table is chrome, and its own
  // rung took the event further up the ladder.
  const chrome = getEditorChrome(editor);
  if (chrome && isEditorChromeElement(chrome, target.element)) return null;
  return { anchor: selection.$anchorCell.pos, head: selection.$headCell.pos };
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
