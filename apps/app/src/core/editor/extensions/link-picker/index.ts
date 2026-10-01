/**
 * The `[[` link picker's public seam (§5.5).
 *
 * The host supplies the project's documents and the holder's address; this
 * lane supplies the trigger, the rows, and what a choice writes (a standard
 * Markdown link); the surface in `features/editor/surfaces/link/` renders the
 * open menu. Nothing outside this directory needs the suggestion plugin or the
 * predicate.
 */

export { type DocumentLinkRange, insertDocumentLink } from "./document-link-insertion";
export {
  getLinkPickerMenu,
  LinkPickerExtension,
  type LinkPickerExtensionOptions,
  type LinkPickerMenu,
} from "./LinkPickerExtension";
export {
  type LinkPickerCatalog,
  type LinkPickerDocument,
  type LinkPickerItem,
  linkPickerItems,
} from "./link-picker-items";
export { allowsLinkPickerTrigger } from "./link-picker-trigger";
