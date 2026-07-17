/** Table transforms that are intentionally absent from prosemirror-tables. */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import type { Command, EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

export type TableSelection = {
  table: ProseMirrorNode;
  tablePos: number;
  row: number;
  column: number;
};

export function tableSelection(state: EditorState): TableSelection | null {
  const { $from } = state.selection;
  let tableDepth = -1;
  let rowDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const role = $from.node(depth).type.spec.tableRole;
    if (rowDepth < 0 && role === "row") rowDepth = depth;
    if (role === "table") {
      tableDepth = depth;
      break;
    }
  }
  if (tableDepth < 0 || rowDepth < 0) return null;

  return {
    table: $from.node(tableDepth),
    tablePos: $from.before(tableDepth),
    row: $from.index(tableDepth),
    column: $from.index(rowDepth),
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
    const target = selection.row + direction;
    // Row zero is the structural GFM header and never participates in moves.
    if (selection.row === 0 || target <= 0 || target >= selection.table.childCount) return false;

    const rows: ProseMirrorNode[] = [];
    selection.table.forEach((row) => {
      rows.push(row);
    });
    [rows[selection.row], rows[target]] = [rows[target], rows[selection.row]];
    const table = selection.table.copy(Fragment.fromArray(rows));
    return replaceTable(state, dispatch, selection, table, target, selection.column);
  };
}

export function moveTableColumn(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection || hasSpans(selection.table)) return false;
    const target = selection.column + direction;
    const columnCount = selection.table.firstChild?.childCount ?? 0;
    if (target < 0 || target >= columnCount) return false;

    const rows: ProseMirrorNode[] = [];
    selection.table.forEach((row) => {
      const cells: ProseMirrorNode[] = [];
      row.forEach((cell) => {
        cells.push(cell);
      });
      [cells[selection.column], cells[target]] = [cells[target], cells[selection.column]];
      rows.push(row.copy(Fragment.fromArray(cells)));
    });
    const table = selection.table.copy(Fragment.fromArray(rows));
    return replaceTable(state, dispatch, selection, table, selection.row, target);
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
        if (column === selection.column) {
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
