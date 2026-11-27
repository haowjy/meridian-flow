import type { Block } from "../codec-types.js";
import type { BlockRef } from "../handles.js";
import type { EditOp } from "../ports/model.js";

/**
 * Resolver → apply seam. Block references are live objects from one local document;
 * a ResolvedEdit must never escape the call that created it or cross process/doc boundaries.
 */
export type ResolvedEdit = {
  documentId: string;
  file: string;
  structuralBoundary?: object;
  pieceOf?: BlockRef;
} & (
  | {
      kind: "ops";
      block: BlockRef;
      ops: readonly EditOp[];
      tookFrom?: readonly BlockRef[];
    }
  | {
      kind: "insert";
      after?: BlockRef;
      insertionRun?: object;
      newText: string;
      blocks: readonly Block[];
    }
  | {
      kind: "delete";
      block: BlockRef;
    }
);

export type EditResolutionErrorCode =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found";

/** What the model reads when an edit did not land because the server failed; it asks for no retry. */
export const EDIT_FAILED_MESSAGE = "The edit did not land: the server failed while applying it.";

export type ApplyErrorCode = EditResolutionErrorCode | "partial_failure" | "internal_error";

export type ApplyTransactionOrigin = unknown;

export interface ApplyEchoHunk {
  mode: "suppressed" | "truncated" | "full";
  blocks: string[];
}

export type ApplyResult =
  | {
      ok: true;
      changedBlocks: string[];
      deletedBlocks: string[];
      insertedBlocks: string[];
    }
  | {
      ok: false;
      error: {
        code: ApplyErrorCode;
        message: string;
        details?: Record<string, unknown>;
        committedEdits?: number;
      };
    };
