/** Table transforms that are intentionally absent from prosemirror-tables. */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import type { Command, EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import {
  addRowAfter,
  addRowBefore,
  CellSelection,
  isInTable,
  selectionCell,
  TableMap,
} from "@tiptap/pm/tables";

export type TableSelection = {
  table: ProseMirrorNode;
  tablePos: number;
  /** Grid row of the cell the caret is in, not its index among row children. */
  row: number;
  /** Grid column of that cell. Diverges from the child index once spans exist. */
  column: number;
  rowFrom: number;
  rowTo: number;
  columnFrom: number;
  columnTo: number;
};

/**
 * Where the selection stands in a table, in GRID coordinates.
 *
 * Grid rather than child index is the point: a spanned cell occupies several
 * columns, so `row.child(2)` and "column 2" stop meaning the same thing the
 * moment a writer merges anything. `TableMap` is what knows the difference, so
 * every reading here goes through it.
 */
export function tableSelection(state: EditorState): TableSelection | null {
  if (!isInTable(state)) return null;

  const $cell = selectionCell(state);
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const current = map.findCell($cell.pos - tableStart);

  const { selection } = state;
  const rect =
    selection instanceof CellSelection
      ? map.rectBetween(
          selection.$anchorCell.pos - tableStart,
          selection.$headCell.pos - tableStart,
        )
      : current;

  return {
    table,
    tablePos: tableStart - 1,
    row: current.top,
    column: current.left,
    rowFrom: rect.top,
    rowTo: rect.bottom - 1,
    columnFrom: rect.left,
    columnTo: rect.right - 1,
  };
}

/**
 * Whether row zero is a header row.
 *
 * The header is a real toggleable thing (§5.4 requirement 3), not a structural
 * given: plenty of status screens have none. Transforms that must not disturb
 * it ask this rather than assuming row zero is sacred, or a headerless table's
 * first row becomes unreachable to insert-above and to moves.
 */
export function hasHeaderRow(table: ProseMirrorNode): boolean {
  const first = table.firstChild?.firstChild;
  return first?.type.spec.tableRole === "header_cell";
}

/** Any merged cell in the table. Row and column moves refuse across one. */
export function tableHasSpans(table: ProseMirrorNode): boolean {
  let found = false;
  table.descendants((node) => {
    if (
      (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") &&
      (node.attrs.colspan !== 1 || node.attrs.rowspan !== 1)
    ) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function cellTextPosition(table: ProseMirrorNode, tablePos: number, row: number, column: number) {
  let rowPos = tablePos + 1;
  for (let index = 0; index < row; index += 1) rowPos += table.child(index).nodeSize;
  const rowNode = table.child(row);
  let cellPos = rowPos + 1;
  for (let index = 0; index < column; index += 1) cellPos += rowNode.child(index).nodeSize;
  return cellPos + 2;
}

function replaceTable(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  selection: TableSelection,
  table: ProseMirrorNode,
  row: number,
  column: number,
) {
  if (!dispatch) return true;
  const tr = state.tr.replaceWith(
    selection.tablePos,
    selection.tablePos + selection.table.nodeSize,
    table,
  );
  const cursor = cellTextPosition(table, selection.tablePos, row, column);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cursor))).scrollIntoView();
  dispatch(tr);
  return true;
}

export function moveTableRow(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection || tableHasSpans(selection.table)) return false;
    // Where a header row exists it is structural: it never moves, and no body
    // row moves above it. A headerless table has no such floor.
    const floor = hasHeaderRow(selection.table) ? 1 : 0;
    if (
      selection.rowFrom < floor ||
      (direction === -1 && selection.rowFrom <= floor) ||
      (direction === 1 && selection.rowTo >= selection.table.childCount - 1)
    ) {
      return false;
    }

    const rows: ProseMirrorNode[] = [];
    selection.table.forEach((row) => {
      rows.push(row);
    });
    const selectedRows = rows.splice(selection.rowFrom, selection.rowTo - selection.rowFrom + 1);
    const insertAt = direction === -1 ? selection.rowFrom - 1 : selection.rowFrom + 1;
    rows.splice(insertAt, 0, ...selectedRows);
    const table = selection.table.copy(Fragment.fromArray(rows));
    return replaceTable(
      state,
      dispatch,
      selection,
      table,
      selection.row + direction,
      selection.column,
    );
  };
}

export function moveTableColumn(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection || tableHasSpans(selection.table)) return false;
    const columnCount = selection.table.firstChild?.childCount ?? 0;
    if (
      (direction === -1 && selection.columnFrom === 0) ||
      (direction === 1 && selection.columnTo >= columnCount - 1)
    ) {
      return false;
    }

    const rows: ProseMirrorNode[] = [];
    selection.table.forEach((row) => {
      const cells: ProseMirrorNode[] = [];
      row.forEach((cell) => {
        cells.push(cell);
      });
      const selectedCells = cells.splice(
        selection.columnFrom,
        selection.columnTo - selection.columnFrom + 1,
      );
      const insertAt = direction === -1 ? selection.columnFrom - 1 : selection.columnFrom + 1;
      cells.splice(insertAt, 0, ...selectedCells);
      rows.push(row.copy(Fragment.fromArray(cells)));
    });
    const table = selection.table.copy(Fragment.fromArray(rows));
    return replaceTable(
      state,
      dispatch,
      selection,
      table,
      selection.row,
      selection.column + direction,
    );
  };
}

/** Text alignment for every cell in the selected columns, spanned cells included. */
export function alignTableColumn(alignment: "left" | "center" | "right"): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection) return false;
    if (!dispatch) return true;

    const map = TableMap.get(selection.table);
    const tableStart = selection.tablePos + 1;
    const tr = state.tr;
    for (const cellPos of map.cellsInRect({
      left: selection.columnFrom,
      right: selection.columnTo + 1,
      top: 0,
      bottom: map.height,
    })) {
      const cell = selection.table.nodeAt(cellPos);
      if (!cell || cell.attrs.alignment === alignment) continue;
      tr.setNodeMarkup(tableStart + cellPos, undefined, { ...cell.attrs, alignment });
    }
    dispatch(tr);
    return true;
  };
}

/** Inserts a body row while preserving the whole-column alignment invariant. */
export function addTableRow(direction: "above" | "below"): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection) return false;
    if (direction === "above" && selection.rowFrom < (hasHeaderRow(selection.table) ? 1 : 0)) {
      return false;
    }

    const command = direction === "above" ? addRowBefore : addRowAfter;
    return command(state, (tr) => {
      const table = tr.doc.nodeAt(selection.tablePos);
      if (!table) return;
      const insertedRow = direction === "above" ? selection.rowFrom : selection.rowTo + 1;
      const map = TableMap.get(table);
      const tableStart = selection.tablePos + 1;

      for (const cellPos of map.cellsInRect({
        left: 0,
        right: map.width,
        top: insertedRow,
        bottom: insertedRow + 1,
      })) {
        // A rowspan from above reaches into the new row without belonging to
        // it; only cells that BEGIN here are the row this insert created.
        const rect = map.findCell(cellPos);
        if (rect.top !== insertedRow) continue;
        const cell = table.nodeAt(cellPos);
        if (!cell) continue;
        const alignment = table.nodeAt(map.map[rect.left])?.attrs.alignment ?? null;
        if (alignment === cell.attrs.alignment) continue;
        tr.setNodeMarkup(tableStart + cellPos, undefined, { ...cell.attrs, alignment });
      }
      dispatch?.(tr);
    });
  };
}

export const resetTableLayout: Command = (state, dispatch) => {
  const selection = tableSelection(state);
  if (!selection) return false;
  if (!dispatch) return true;

  const tr = state.tr.setNodeMarkup(selection.tablePos, undefined, {
    ...selection.table.attrs,
    align: null,
  });
  let rowPos = selection.tablePos + 1;
  selection.table.forEach((row) => {
    let cellPos = rowPos + 1;
    row.forEach((cell) => {
      if (cell.attrs.colwidth !== null) {
        tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, colwidth: null });
      }
      cellPos += cell.nodeSize;
    });
    rowPos += row.nodeSize;
  });
  dispatch(tr);
  return true;
};
