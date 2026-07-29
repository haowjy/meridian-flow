/**
 * The document toolbar surface: the editor's persistent chrome row.
 *
 * Hosts mount `DocumentToolbar`. The command layer behind it
 * (`toolbar-commands.ts`) is exported for the surfaces that will share these
 * verbs — the formatting menu and the block menu carry the same toggles and
 * must refuse the same targets.
 */
export { DocumentToolbar, type DocumentToolbarProps } from "./DocumentToolbar";
export { LinkForm, useLinkDraft } from "./LinkPopover";
export {
  BLOCK_TYPE_IDS,
  type BlockTypeId,
  blockTypeStates,
  documentToolbarControls,
  type ToolbarBlockedReason,
  type ToolbarControlId,
  type ToolbarControlState,
  type ToolbarMarkName,
  textMarkState,
  toggleBulletListBlock,
  toggleHeadingBlock,
  toggleTextMark,
  turnIntoBlockType,
} from "./toolbar-commands";
export { type BlockedSubject, blockedReasonMessage } from "./toolbar-copy";
