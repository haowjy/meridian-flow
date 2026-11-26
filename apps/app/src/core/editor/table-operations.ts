import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Command, EditorState } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import {
  addRowAfter,
  addRowBefore,
  CellSelection,
  isInTable,
  mergeCells,
  selectedRect,
  selectionCell,
  TableMap,
  tableNodeTypes,
} from "@tiptap/pm/tables";

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

export const toggleTableHeaderRow: Command = (state, dispatch) => {
  const selection = tableSelection(state);
  if (!selection) return false;
  if (!dispatch) return true;

  const types = tableNodeTypes(state.schema);
  const target = hasHeaderRow(selection.table) ? types.cell : types.header_cell;
  const map = TableMap.get(selection.table);
  const tableStart = selection.tablePos + 1;
  const tr = state.tr;

  for (const cellPos of map.cellsInRect({ left: 0, right: map.width, top: 0, bottom: 1 })) {
    const cell = selection.table.nodeAt(cellPos);
    if (!cell || cell.type === target) continue;
    tr.setNodeMarkup(tableStart + cellPos, target, cell.attrs);
  }

  if (!tr.docChanged) return false;
  dispatch(tr);
  return true;
};

export function hasHeaderRow(table: ProseMirrorNode): boolean {
  const first = table.firstChild?.firstChild;
  return first?.type.spec.tableRole === "header_cell";
}

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

    if (!dispatch) return true;
    // A move, not a rebuilt table: the selected rows are deleted and inserted at their new
    // place, so the Loro binding sees which rows moved and the rows they pass keep their
    // blocks (and a collaborator's typing in them).
    const rowStart = (index: number) => {
      let pos = selection.tablePos + 1;
      for (let i = 0; i < index; i++) pos += selection.table.child(i).nodeSize;
      return pos;
    };
    const from = rowStart(selection.rowFrom);
    const to = rowStart(selection.rowTo + 1);
    const moved = selection.table.slice(
      from - selection.tablePos - 1,
      to - selection.tablePos - 1,
    ).content;
    const target =
      direction === -1 ? rowStart(selection.rowFrom - 1) : rowStart(selection.rowTo + 2);
    const tr = state.tr.delete(from, to);
    tr.insert(tr.mapping.map(target), moved);
    const table = tr.doc.nodeAt(selection.tablePos);
    if (table) {
      const cursor = cellTextPosition(
        table,
        selection.tablePos,
        selection.row + direction,
        selection.column,
      );
      tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
    }
    dispatch(tr.scrollIntoView());
    return true;
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

    if (!dispatch) return true;
    const tr = state.tr;
    // Delete/insert only the moved cells: replacing their row would hide which cells moved
    // from the binding and could re-create the cell a collaborator is typing in.
    selection.table.forEach((row, rowOffset) => {
      const cellStart = (index: number) => {
        let pos = selection.tablePos + rowOffset + 2;
        for (let i = 0; i < index; i++) pos += row.child(i).nodeSize;
        return pos;
      };
      const from = cellStart(selection.columnFrom);
      const to = cellStart(selection.columnTo + 1);
      const rowStart = selection.tablePos + rowOffset + 2;
      const moved = row.slice(from - rowStart, to - rowStart).content;
      const target =
        direction === -1 ? cellStart(selection.columnFrom - 1) : cellStart(selection.columnTo + 2);
      tr.delete(tr.mapping.map(from), tr.mapping.map(to));
      tr.insert(tr.mapping.map(target), moved);
    });
    const table = tr.doc.nodeAt(selection.tablePos);
    if (table) {
      const cursor = cellTextPosition(
        table,
        selection.tablePos,
        selection.row,
        selection.column + direction,
      );
      tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

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

export function setTablePlacement(align: "center" | "right" | null): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection) return false;
    const attrs = selection.table.attrs;
    if (attrs.align === align) return true;
    dispatch?.(state.tr.setNodeMarkup(selection.tablePos, undefined, { ...attrs, align }));
    return true;
  };
}

export const resetTableColumnWidths: Command = (state, dispatch) => {
  const selection = tableSelection(state);
  if (!selection) return false;

  const tr = state.tr;
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

  if (!tr.docChanged) return false;
  dispatch?.(tr);
  return true;
};

/**
 * Would this merge swallow the header row into the body?
 *
 * prosemirror-tables merges any rectangle and keeps the FIRST cell's type, so
 * a whole-column merge on a headed table yields one header cell spanning every
 * row: the header stops being a row and the table stops having one. Merging
 * the header row across itself is a different thing and stays allowed — that
 * is a title row.
 */
export function mergeCrossesHeader(state: EditorState): boolean {
  if (!isInTable(state) || !(state.selection instanceof CellSelection)) return false;
  const rect = selectedRect(state);
  return hasHeaderRow(rect.table) && rect.top === 0 && rect.bottom > 1;
}

/**
 * Merge, refusing to swallow the header row.
 *
 * Cells hold block sequences, so prosemirror-tables' own merge is already
 * legal: every filled cell's blocks land in the merged cell in reading order.
 * The header guard is the load-bearing part — the greyed menu item is the
 * first fence and this is the second; nothing else stops a programmatic merge
 * from taking the header row with it.
 */
export const mergeTableCells: Command = (state, dispatch) => {
  if (mergeCrossesHeader(state)) return false;
  return mergeCells(state, dispatch);
};
