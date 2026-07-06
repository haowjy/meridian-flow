/** JSON wire contracts for reviewing AI document drafts before they touch live documents. */

export * from "./review.js";

/** 1-day retention window for draft undo operations. */
export const DRAFT_UNDO_RETENTION_MS = 24 * 60 * 60 * 1000;
