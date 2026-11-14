import type { Block } from "../codec-types.js";
import type { BlockRef } from "../handles.js";
import type { EditOp } from "../ports/model.js";

/** The text an `ops` edit puts in, in order: its output for the semantic IR. */
export function opsOutput(ops: readonly EditOp[]): string {
  let output = "";
  for (const op of ops)
    if (op.kind === "text")
      for (const splice of op.splices)
        output += splice.content.textBetween(0, splice.content.size, "");
    else if (op.kind === "insert") for (const node of op.nodes) output += node.textContent;
  return output;
}

/**
 * Resolver → apply seam. Block references are live objects from one local document;
 * a ResolvedEdit must never escape the call that created it or cross process/doc boundaries.
 */
export type ResolvedEdit = {
  documentId: string;
  file: string;
  /** Shared only by edits crossing a recognized adjacent paragraph boundary. */
  structuralBoundary?: object;
} & (
  | {
      /** The smallest changes to one block: its text, formatting, attributes and nodes. */
      kind: "ops";
      block: BlockRef;
      ops: readonly EditOp[];
    }
  | {
      kind: "insert";
      after?: BlockRef;
      /** Ordered insertions sharing an old anchor chain through their newly inserted tail. */
      insertionRun?: object;
      /** Provenance text for the semantic IR; it never drives the insert. */
      newText: string;
      /**
       * The nodes inserted, exactly as resolved (parsed, reconstructed or copied).
       * No markup round trip happens between resolution and application.
       */
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

export type ApplyErrorCode = EditResolutionErrorCode | "partial_failure" | "internal_error";

export interface AgentOrigin {
  type: "agent";
  actorTurnId: string;
  /** Permanent model-facing chat handle, resolved by the host (for example `c15`). */
  author?: string;
}

export type ApplyTransactionOrigin = unknown;

export type ConcurrentUpdateOrigin =
  | AgentOrigin
  | { type: "human"; userId: string }
  | { type: "system" }
  | { type: "unattributed" };

export interface ConcurrentUpdate {
  update: Uint8Array;
  origin: ConcurrentUpdateOrigin;
  /** Cross-room projections can name affected target blocks without replaying foreign Yjs ids. */
  effects?: { changed: readonly string[]; removed: readonly string[] };
}

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
