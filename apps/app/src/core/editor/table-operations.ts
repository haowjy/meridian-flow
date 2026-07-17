/** Table transforms that are intentionally absent from prosemirror-tables. */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import type { Command, EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { addRowAfter, addRowBefore, CellSelection } from "@tiptap/pm/tables";

export type TableSelection = {
  table: ProseMirrorNode;
  tablePos: number;
  row: number;
  column: number;
  rowFrom: number;
  rowTo: number;
  columnFrom: number;
  columnTo: number;
};

function tablePoint($pos: EditorState["selection"]["$from"]) {
  let tableDepth = -1;
  let rowDepth = -1;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (rowDepth < 0 && role === "row") rowDepth = depth;
    if (role === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0 || rowDepth < 0) return null;
  return {
    table: $pos.node(tableDepth),
    tablePos: $pos.before(tableDepth),
    row: $pos.index(tableDepth),
    column: $pos.index(rowDepth),
  };
}

export function tableSelection(state: EditorState): TableSelection | null {
  const point = tablePoint(state.selection.$from);
  if (!point) return null;

  if (state.selection instanceof CellSelection) {
    const anchor = tablePoint(state.selection.$anchorCell);
    const head = tablePoint(state.selection.$headCell);
    if (!anchor || !head || anchor.tablePos !== head.tablePos) return null;
    return {
      ...point,
      rowFrom: Math.min(anchor.row, head.row),
      rowTo: Math.max(anchor.row, head.row),
      columnFrom: Math.min(anchor.column, head.column),
      columnTo: Math.max(anchor.column, head.column),
    };
  }

  return {
    ...point,
    rowFrom: point.row,
    rowTo: point.row,
    columnFrom: point.column,
    columnTo: point.column,
  };
}

function hasSpans(table: ProseMirrorNode): boolean {
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
    if (!selection || hasSpans(selection.table)) return false;
    // Row zero is the structural GFM header and never participates in moves.
    if (
      selection.rowFrom === 0 ||
      (direction === -1 && selection.rowFrom <= 1) ||
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
    if (!selection || hasSpans(selection.table)) return false;
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

export function alignTableColumn(alignment: "left" | "center" | "right"): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection || hasSpans(selection.table)) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    let rowPos = selection.tablePos + 1;
    selection.table.forEach((row) => {
      let cellPos = rowPos + 1;
      row.forEach((cell, _offset, column) => {
        if (column >= selection.columnFrom && column <= selection.columnTo) {
          tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, alignment });
        }
        cellPos += cell.nodeSize;
      });
      rowPos += row.nodeSize;
    });
    dispatch(tr);
    return true;
  };
}

/** Inserts a body row while preserving the whole-column alignment invariant. */
export function addTableRow(direction: "above" | "below"): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection || hasSpans(selection.table)) return false;
    if (direction === "above" && selection.rowFrom === 0) return false;

    const command = direction === "above" ? addRowBefore : addRowAfter;
    return command(state, (tr) => {
      const table = tr.doc.nodeAt(selection.tablePos);
      if (!table) return;
      const insertedRow = direction === "above" ? selection.rowFrom : selection.rowTo + 1;
      const row = table.child(insertedRow);
      const header = table.firstChild;
      if (!header) return;

      let rowPos = selection.tablePos + 1;
      for (let index = 0; index < insertedRow; index += 1) rowPos += table.child(index).nodeSize;
      let cellPos = rowPos + 1;
      row.forEach((cell, _offset, column) => {
        const alignment = header.child(column).attrs.alignment;
        if (alignment !== cell.attrs.alignment) {
          tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, alignment });
        }
        cellPos += cell.nodeSize;
      });
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
