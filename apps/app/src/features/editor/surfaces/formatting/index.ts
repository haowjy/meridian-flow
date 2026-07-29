/**
 * The formatting menu surface (M4): the menu a writer asks for over a
 * selection, and the pieces a probe or a sibling lane reaches for.
 *
 * `chrome-surfaces.tsx` mounts `FormattingMenu` and nothing else here is a
 * mounting concern. The trigger predicates are exported because the right-click
 * split matrix is a cross-lane contract, not this module's private business.
 */

export {
  type ClipboardAccess,
  type ClipboardAvailability,
  type ClipboardResult,
  clipboardAccess,
  copySelection,
  cutSelection,
  pasteIntoSelection,
} from "./clipboard-commands";
export { ClipboardMenuItems, clipboardItemStates } from "./clipboard-menu";
export { FormattingMenu } from "./FormattingMenu";
export {
  FORMATTING_CLIPBOARD_IDS,
  type FormattingClipboardId,
  type FormattingItemState,
  type FormattingMarkId,
  type FormattingMenuModel,
  formattingMenuModel,
} from "./formatting-menu-items";
export {
  claimsFormattingMenu,
  type FormattingMenuPoint,
  formattingMenuOpensFor,
  formattingOwnsContext,
  isProseSelection,
} from "./formatting-triggers";
