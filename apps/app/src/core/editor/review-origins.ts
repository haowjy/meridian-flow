/** review-origins — Yjs origins for ephemeral review UndoManager tracking. */
import { HUNK_REJECT_ORIGIN } from "./extensions/inline-review/DraftInlineReviewExtension";

export const REVIEW_APPLY_ORIGIN = Symbol("review-apply");
export const REVIEW_DISCARD_ORIGIN = HUNK_REJECT_ORIGIN;
