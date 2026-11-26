import { Fragment, type Node as PMNode, type Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { __pastedCells, CellSelection, selectedRect } from "@tiptap/pm/tables";
import { Transform } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

const TABLE_SWEEP_PASTE_NAME = "meridianTableSweepPaste";

export function tableSweepPastePlugin(): Plugin {
  return new Plugin({
    key: new PluginKey(TABLE_SWEEP_PASTE_NAME),
    props: {
      handlePaste: (view, _event, slice) => sweepPasteReplace(view, slice),
    },
  });
}

function sweepPasteReplace(view: EditorView, slice: Slice): boolean {
  const { state } = view;
  if (!(state.selection instanceof CellSelection)) return false;
  if (slice.size === 0) return false;
  if (__pastedCells(slice)) return false;

  const landed = sweepReplaceLanding(state, (cell) => fitIntoCell(cell, slice));
  if (!landed) return false;
  view.dispatch(landed.transaction.scrollIntoView());
  return true;
}

export type SweepLanding = { transaction: Transaction; from: number; to: number };

export function sweepReplaceLanding(
  state: EditorState,
  landing: (cell: PMNode) => Fragment,
): SweepLanding | null {
  if (!(state.selection instanceof CellSelection)) return null;

  const rect = selectedRect(state);
  const cells = rect.map.cellsInRect(rect);
  const transaction = state.tr;
  let landed: { from: number; to: number } | null = null;

  // Back to front, so a replacement never moves a cell still waiting its turn
  // — which is also what lets the top-left cell's range survive unmapped.
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = rect.table.nodeAt(cells[index]);
    if (!cell) continue;
    const from = rect.tableStart + cells[index] + 1;
    const content = index === 0 ? landing(cell) : emptiedCell(cell);
    transaction.replaceWith(from, from + cell.content.size, content);
    if (index === 0) landed = { from, to: from + content.size };
  }

  if (!landed) return null;
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(landed.to), -1));
  return { transaction, ...landed };
}

function fitIntoCell(cell: PMNode, slice: Slice): Fragment {
  const seed = cell.type.createAndFill();
  if (!seed) return Fragment.empty;
  return new Transform(seed).replace(0, seed.content.size, slice).doc.content;
}

function emptiedCell(cell: PMNode): Fragment {
  return Fragment.from(cell.type.contentMatch.fillBefore(Fragment.empty, true));
}
