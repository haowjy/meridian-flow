/**
 * Explicit position semantics: all positions are offsets in the base text
 * (the text before the proposal update is applied).
 */

export interface InsertOp {
  kind: "insert";
  /** Position in base text where the insertion occurs (text before this position is unchanged). */
  basePos: number;
  insertedText: string;
}

export interface DeleteOp {
  kind: "delete";
  /** Start offset in base text (inclusive). */
  baseStart: number;
  /** End offset in base text (exclusive). */
  baseEnd: number;
  deletedText: string;
}

export interface ReplaceOp {
  kind: "replace";
  /** Start offset in base text (inclusive). */
  baseStart: number;
  /** End offset in base text (exclusive). */
  baseEnd: number;
  deletedText: string;
  insertedText: string;
}

/** A single atomic edit operation with exact base-text position semantics. */
export type EditOp = InsertOp | DeleteOp | ReplaceOp;

export type ReviewChunkStatus = "pending" | "accepted" | "rejected";

/**
 * A prose-grouped unit of change for proposal review.
 *
 * Covers a contiguous region of the base text. Multiple adjacent EditOps
 * may be merged into a single ReviewChunk by the grouper when they are
 * close enough (same paragraph or separated by <=2 lines).
 *
 * For pure inserts: baseStart === baseEnd, deletedText === "".
 * For pure deletes: insertedText === "".
 */
export interface ReviewChunk {
  /** Stable id: deterministic from proposalId + chunk index. */
  id: string;
  proposalId: string;
  /** Start offset in base text (inclusive). */
  baseStart: number;
  /** End offset in base text (exclusive). For pure inserts, equals baseStart. */
  baseEnd: number;
  /** Text from base document that this chunk covers. Empty for pure inserts. */
  deletedText: string;
  /** Text that the proposed document has in place of deletedText. Empty for pure deletes. */
  insertedText: string;
  status: ReviewChunkStatus;
}
