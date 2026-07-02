/** Public entry for the DraftInlineReviewExtension module. */
export {
  DraftInlineReviewExtension,
  type DraftInlineReviewOptions,
  draftInlineReviewPluginKey,
  firstPositionForOperation,
  getInlineReviewPluginState,
  HUNK_REJECT_ORIGIN,
  type InlineReviewPluginState,
} from "./DraftInlineReviewExtension";
export { inlineReviewClassNames } from "./decorations";
export {
  buildInlineReviewModel,
  decodeAnchor,
  hunkKind,
  type InlineReviewModel,
  type InlineReviewOperationKind,
  indexOperations,
  type ResolvedReviewHunk,
} from "./model";
