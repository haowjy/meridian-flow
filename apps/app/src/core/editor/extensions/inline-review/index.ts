export {
  type AppliedChangeRef,
  currentReview,
  DraftInlineReviewExtension,
  draftInlineReviewPluginKey,
  getInlineReviewPluginState,
  type InlineReviewPluginState,
  inlineReviewFocusIntent,
} from "./DraftInlineReviewExtension";
export { CHANGE_ATTR, inlineReviewClassNames } from "./decorations";
export {
  contentHashOf,
  isSameChange,
  type ProjectedReview,
  removedParagraphs,
  sameContent,
} from "./model";
export { BAR_SLOT_ATTR, REMOVED_BLOCKS_ATTR } from "./removal-widget";
