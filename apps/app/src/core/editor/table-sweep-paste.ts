/**
 * Paste over a swept rectangle of cells is a replace of the sweep.
 *
 * prosemirror-tables' own `handlePaste` fans a non-table clipboard into every
 * swept cell (`clipCells` repeats it to fill the rectangle). Meridian's rule
 * is the one paste means everywhere else: the sweep is a selection, and paste
 * replaces the selection — the swept cells are emptied and the clipboard lands
 * whole in the rectangle's top-left cell, in one transaction so one undo takes
 * all of it back. The single exception is prosemirror-tables' own, kept
 * deliberately: table content over a sweep stays the rectangle overwrite,
 * because cells map onto cells. This plugin declines that case and the stock
 * handler behind it answers.
 *
 * A plugin rather than an editor prop so its `handlePaste` sits in front of
 * `tableEditing`'s on the same ladder: `MeridianTable` mounts it before its
 * parent's plugins.
 *
 * A pasted image FILE never reaches this ladder: it carries no slice, so
 * `ImageIngressExtension` claims it at the clipboard. That door still lands
 * through `sweepReplaceLanding` below, so what "paste replaces a sweep" means
 * is decided here once, whichever kind of clipboard arrives.
 */

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

/**
 * Replace a swept `CellSelection` with the pasted slice. False whenever this
 * paste is not that: no sweep, an empty clipboard, or table content — each
 * falls through to the handler that owns it.
 */
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

/** A sweep-replace, built but not dispatched: the landed content's range too. */
export type SweepLanding = { transaction: Transaction; from: number; to: number };

/**
 * The one shape of "paste replaces a sweep": every swept cell emptied, the
 * `landing` content standing whole in the rectangle's top-left cell, the caret
 * after it — one transaction, so one undo takes all of it back. Null when the
 * selection is not a sweep. Every paste door lands through here — this
 * plugin's clipboard slices, and the image lane's pasted file
 * (`images/image-uploads.ts`) — so no door invents its own answer.
 */
export function sweepReplaceLanding(
  state: EditorState,
  landing: (cell: PMNode) => Fragment,
): SweepLanding | null {
  if (!(state.selection instanceof CellSelection)) return null;

  const rect = selectedRect(state);
  // Row-major, so the first entry is the rectangle's top-left cell — the
  // landing, whichever corner the writer dragged from.
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

/** The clipboard as this cell can hold it, however open the slice arrived. */
function fitIntoCell(cell: PMNode, slice: Slice): Fragment {
  const seed = cell.type.createAndFill();
  if (!seed) return Fragment.empty;
  return new Transform(seed).replace(0, seed.content.size, slice).doc.content;
}

/** What an emptied cell holds: the least content its type requires. */
function emptiedCell(cell: PMNode): Fragment {
  return Fragment.from(cell.type.contentMatch.fillBefore(Fragment.empty, true));
}
