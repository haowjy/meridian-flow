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
  mergeCells,
  selectedRect,
  selectionCell,
  TableMap,
  tableNodeTypes,
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
 * Turn the table's header row on or off (law 6: one control, both directions).
 *
 * prosemirror-tables' `toggleHeaderRow` toggles header-ness of whatever ROWS
 * are selected, so with the table selected it makes every row a header, and
 * with the caret in the last row it makes THAT row a header. "Header row" names
 * one row — the first — and means the same thing from wherever it is pressed.
 */
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

/**
 * Where the table sits in the measure (§5.4). `null` is the default flow,
 * which is what "left" means for a block that is already left-aligned.
 */
export function setTablePlacement(align: "center" | "right" | null): Command {
  return (state, dispatch) => {
    const selection = tableSelection(state);
    if (!selection) return false;
    if (selection.table.attrs.align === align) return true;
    dispatch?.(
      state.tr.setNodeMarkup(selection.tablePos, undefined, { ...selection.table.attrs, align }),
    );
    return true;
  };
}

/** Drops every persisted column width so the table sizes to its content again. */
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
 * The cells in the selected rectangle that hold something, in reading order.
 *
 * "Empty" is prosemirror-tables' own reckoning — one childless text block —
 * because that is what its merge skips, and the two have to agree about which
 * cells carry text or the join below would move text the merge also appends.
 */
function filledCellsInSelection(state: EditorState): { positions: number[]; tableStart: number } {
  const rect = selectedRect(state);
  const seen = new Set<number>();
  const positions: number[] = [];

  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let column = rect.left; column < rect.right; column += 1) {
      const cellPos = rect.map.map[row * rect.map.width + column];
      if (seen.has(cellPos)) continue;
      seen.add(cellPos);
      const cell = rect.table.nodeAt(cellPos);
      if (cell && cell.content.size > 0 && cell.textContent.length > 0) positions.push(cellPos);
    }
  }

  return { positions, tableStart: rect.tableStart };
}

/**
 * Whether merging here will run two cells' text together — the one thing about
 * the verb a writer cannot see before pressing it, so the menu says so.
 */
export function mergeJoinsCellText(state: EditorState): boolean {
  if (!isInTable(state) || !(state.selection instanceof CellSelection)) return false;
  return filledCellsInSelection(state).positions.length > 1;
}

/**
 * Merge, under a schema where a cell holds exactly one paragraph.
 *
 * prosemirror-tables appends every filled cell's content into the merged cell,
 * which is two paragraphs where this schema allows one. The replace is then
 * fitted to the schema: the cell closes, a new row opens, and a cell's text is
 * simply gone. Running the text together into one paragraph FIRST leaves a
 * single filled cell, which the library merges cleanly.
 *
 * When cells hold several paragraphs on the wire (the codec escalation), this
 * join is what goes away, and `mergeCells` stands on its own.
 */
export const mergeTableCells: Command = (state, dispatch) => {
  if (!mergeCells(state)) return false;
  if (!dispatch) return true;

  const { positions, tableStart } = filledCellsInSelection(state);
  if (positions.length < 2) return mergeCells(state, dispatch);

  const table = selectedRect(state).table;
  const space = state.schema.text(" ");
  let joined = Fragment.empty;
  for (const cellPos of positions) {
    const paragraph = table.nodeAt(cellPos)?.firstChild;
    if (!paragraph || paragraph.content.size === 0) continue;
    joined =
      joined.size === 0
        ? paragraph.content
        : joined.append(Fragment.from(space)).append(paragraph.content);
  }

  // Back to front: rewriting a cell's text moves everything after it, and
  // nothing before it.
  const tr = state.tr;
  for (const cellPos of [...positions].reverse()) {
    const paragraph = table.nodeAt(cellPos)?.firstChild;
    if (!paragraph) continue;
    const from = tableStart + cellPos + 2;
    const to = from + paragraph.content.size;
    if (cellPos === positions[0]) tr.replaceWith(from, to, joined);
    else tr.delete(from, to);
  }

  const withText = state.apply(tr);
  // A plugin that rewrote the document underneath the join would invalidate
  // the merge steps below; giving up on the join is better than mis-stepping.
  if (withText.doc !== tr.doc) return mergeCells(state, dispatch);

  return mergeCells(withText, (mergeTr) => {
    for (const step of mergeTr.steps) tr.step(step);
    dispatch(tr.scrollIntoView());
  });
};
