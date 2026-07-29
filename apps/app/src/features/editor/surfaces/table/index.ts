/**
 * The table surface: outside-frame grips, add tabs, row/column/table menus,
 * and the Alt+Arrow keymap that owns row and column movement inside a table.
 *
 * `TableChrome` is the whole mount; the command layer is exported beside it
 * because the verbs are the table's, not the chrome's — a slash command or a
 * future block menu that wants "insert row below" should run the same command
 * with the same refusal, not a second copy of it.
 */

export { TableChrome } from "./TableChrome";
export {
  appendTableAxis,
  runTableVerb,
  selectedColumnAlignment,
  selectedTablePlacement,
  selectTableAxis,
  TABLE_VERB_COMMANDS,
  TABLE_VERB_IDS,
  type TableAlignment,
  type TableBlockedReason,
  type TablePlacement,
  type TableVerbId,
  type TableVerbState,
  type TableVerbStates,
  tableVerbStates,
} from "./table-commands";
export { tableBlockedMessage, tableVerbLabel } from "./table-copy";
