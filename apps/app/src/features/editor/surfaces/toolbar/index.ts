/**
 * The document toolbar surface: the editor's persistent chrome row.
 *
 * Hosts mount `DocumentToolbar`. The command layer behind it
 * (`toolbar-commands.ts`) is exported for the surfaces that will share these
 * verbs — the formatting menu and the block menu carry the same toggles and
 * must refuse the same targets.
 */
export { DocumentToolbar, type DocumentToolbarProps } from "./DocumentToolbar";
export {
  type BlockTypeRefusalReason,
  blockTypeRefusal,
  codeBlockRefusal,
  documentToolbarControls,
  type ToolbarBlockedReason,
  type ToolbarControlId,
  type ToolbarControlState,
  toggleBulletListBlock,
  toggleHeadingBlock,
  toggleTextMark,
} from "./toolbar-commands";
export { blockTypeReasonMessage } from "./toolbar-copy";
