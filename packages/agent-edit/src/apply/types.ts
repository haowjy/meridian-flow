import type { BlockRef } from "../handles.js";

export interface ResolvedSpan {
  start: number;
  end: number;
}

/**
 * Resolver → apply seam. Block references are live objects from one local document;
 * a ResolvedEdit must never escape the call that created it or cross process/doc boundaries.
 */
export type ResolvedEdit = { documentId: string; file: string } & (
  | {
      kind: "text";
      block: BlockRef;
      span: ResolvedSpan;
      newText: string;
    }
  | {
      kind: "insert";
      after?: BlockRef;
      newText: string;
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

export type ApplyTier = 1 | 2 | 3;

export interface AgentOrigin {
  type: "agent";
  actorTurnId: string;
}

export type ApplyTransactionOrigin = unknown;

export type ConcurrentUpdateOrigin =
  | AgentOrigin
  | { type: "human"; userId?: string }
  | { type: "system" };

export interface ConcurrentUpdate {
  update: Uint8Array;
  origin: ConcurrentUpdateOrigin;
  /**
   * Final-state block hashes to use as attribution authority when update bytes
   * are only transport and cannot identify stable origins after re-materialization.
   */
  touchedHashes?: {
    human?: readonly string[];
    agent?: readonly string[];
  };
  /** Precomputed aggregate collapse decision from the attribution kernel. */
  collapsed?: boolean;
}

export interface ApplyEditsOptions {
  /** Actor turn id used only to ignore this actor's own re-sync updates; never embedded in transaction origin. */
  ownActorTurnId?: string;
  /** State vector from the actor's last explicit sync (V_sync); defaults to the pre-apply doc vector. */
  syncStateVector?: Uint8Array;
  /** Re-sync updates from other actors, applied after local edits and before echo computation. */
  concurrentUpdates?: readonly ConcurrentUpdate[];
  concurrentCollapseThreshold?: number;
}

export interface AppliedEditSummary {
  kind: ResolvedEdit["kind"];
  tier: ApplyTier;
  blockIds: string[];
}

export interface ApplyEchoHunk {
  mode: "suppressed" | "truncated" | "full";
  blocks: string[];
}

export interface ConcurrentEditInfo {
  human: string[];
  agent: string[];
  /** Read-format `hash|body` lines for changed/inserted blocks; `hash| (deleted)` for deletes. */
  renderedBlocks?: { human: string[]; agent: string[] };
  collapsed?: boolean;
  reviewCommand?: string;
}

export type ApplyResult =
  | {
      ok: true;
      status: "success";
      documentId: string;
      file: string;
      echo: ApplyEchoHunk[];
      concurrentEdits?: ConcurrentEditInfo;
      changedBlocks?: string[];
      deletedBlocks?: string[];
      appliedEdits?: AppliedEditSummary[];
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
