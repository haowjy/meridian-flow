/**
 * The composer's input engine: a minimal TipTap schema, the `@` suggestion
 * that inserts atomic reference tokens, the menu it opens, and the one
 * serialization the wire reads. `Composer.tsx` is the surface over this.
 */

export { ComposerReferenceMenu } from "./ComposerReferenceMenu";
export { type ComposerExtensionsOptions, createComposerExtensions } from "./composer-extensions";
export {
  type ComposerReferenceItem,
  type ComposerReferenceOptions,
  closedComposerReferenceMenu,
  getComposerReferenceMenu,
  insertComposerReference,
} from "./composer-reference-suggestion";
export {
  type ComposerImageBlock,
  composerImageBlocks,
  serializeComposerFragment,
  serializeComposerText,
} from "./composer-serialization";
export {
  composerReferenceTokens,
  REFERENCE_TOKEN_NODE,
  type ReferenceTokenAttributes,
} from "./reference-token";
