/**
 * The `@` lane's public seam.
 *
 * The host supplies everything the project can name plus the copy the menu
 * shows; this lane supplies the trigger, the scope, and what a choice writes;
 * the surface in `features/editor/surfaces/link/` renders the open menu. What
 * the rows are and how they rank is
 * [`@/core/references`](../../../references/index.ts), which `[[` and the
 * composer share. Nothing outside this directory needs the suggestion plugin or
 * the predicate.
 */

export {
  AtReferenceExtension,
  type AtReferenceExtensionOptions,
  type AtReferenceMenu,
  getAtReferenceMenu,
} from "./AtReferenceExtension";
export type {
  AtReferenceCatalog,
  AtReferenceItem,
  AtReferenceMeta,
} from "./at-reference-catalog";
