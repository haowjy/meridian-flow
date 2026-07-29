/**
 * Writer-facing copy for the table verbs and, more importantly, for the
 * reasons they grey out.
 *
 * Law 5 is only satisfied when the reason reads as an answer ("the header row
 * stays first"), so the whole matrix lives here where it can be read at once
 * and a missing reason is visible as a hole rather than as a silently dead
 * control.
 */
import { t } from "@lingui/core/macro";

import type { TableBlockedReason, TableVerbId } from "./table-commands";

export function tableVerbLabel(verb: TableVerbId): string {
  switch (verb) {
    case "insertRowAbove":
      return t`Insert row above`;
    case "insertRowBelow":
      return t`Insert row below`;
    case "moveRowUp":
      return t`Move row up`;
    case "moveRowDown":
      return t`Move row down`;
    case "deleteRow":
      return t`Delete row`;
    case "insertColumnLeft":
      return t`Insert column left`;
    case "insertColumnRight":
      return t`Insert column right`;
    case "moveColumnLeft":
      return t`Move column left`;
    case "moveColumnRight":
      return t`Move column right`;
    case "deleteColumn":
      return t`Delete column`;
    case "mergeCells":
      return t`Merge cells`;
    case "splitCell":
      return t`Split cell`;
    case "alignLeft":
      return t`Align left`;
    case "alignCenter":
      return t`Align center`;
    case "alignRight":
      return t`Align right`;
    case "headerRow":
      return t`Header row`;
    case "placeLeft":
      return t`Left`;
    case "placeCenter":
      return t`Centered`;
    case "placeRight":
      return t`Right`;
    case "resetColumnWidths":
      return t`Reset column widths`;
    case "deleteTable":
      return t`Delete table`;
  }
}

/**
 * The one line under a verb that says what it will make. Merging is the only
 * verb whose result a writer cannot see coming, so it says which one it is.
 */
export function tableVerbHint(
  verb: TableVerbId,
  { mergeJoinsText = false }: { mergeJoinsText?: boolean } = {},
): string | null {
  if (verb !== "mergeCells") return null;
  return mergeJoinsText ? t`Runs the text together in one cell` : t`One cell across the selection`;
}

export function tableBlockedMessage(
  verb: TableVerbId,
  reason: TableBlockedReason | null,
): string | null {
  if (!reason) return null;
  switch (reason) {
    case "no-table":
      return t`Put the caret in a table first.`;
    case "document-read-only":
      return t`This document is read only right now.`;
    case "header-row-first":
      return t`The header row stays first.`;
    case "at-table-edge":
      return isColumnVerb(verb)
        ? t`This column is already at the edge.`
        : t`This row is already at the edge.`;
    case "merged-cells":
      return t`Merged cells stay where they are.`;
    case "single-row":
      return t`A table keeps at least one row.`;
    case "single-column":
      return t`A table keeps at least one column.`;
    case "one-cell-selected":
      return t`Select more than one cell to merge them.`;
    case "cells-not-rectangular":
      return t`Merging works on a rectangle of cells.`;
    case "not-merged":
      return t`This cell is not merged.`;
    case "no-column-widths":
      return t`No column has been resized yet.`;
  }
}

function isColumnVerb(verb: TableVerbId): boolean {
  return verb === "moveColumnLeft" || verb === "moveColumnRight";
}

export const tableChromeCopy = {
  columnGrip: () => t`Column options`,
  rowGrip: () => t`Row options`,
  addColumn: () => t`Add column`,
  addRow: () => t`Add row`,
  tableControls: () => t`Table controls`,
  tableOptions: () => t`Table options`,
  textAlignment: () => t`Text alignment`,
  tablePlacement: () => t`Table placement`,
  wholeTable: () => t`Table`,
};
