export {
  DraftInlineReviewExtension,
  type DraftInlineReviewOptions,
  draftInlineReviewPluginKey,
  getInlineReviewPluginState,
  type InlineReviewPluginState,
} from "./DraftInlineReviewExtension";
export { inlineReviewClassNames, restoreRenderedChanges } from "./decorations";
export {
  buildInlineReviewModel,
  changeOperationIds,
  decodeAnchor,
  type InlineReviewModel,
  type InlineReviewOperationKind,
  indexOperations,
  isUnattributedHunkKey,
  operationKey,
  type ResolvedBlockReviewHunk,
  type ResolvedReviewHunk,
  type ResolvedTextReviewHunk,
  unattributedHunkKey,
} from "./model";
export { BAR_SLOT_ATTR } from "./removal-widget";
