import type { Fragment } from "prosemirror-model";
import type { Block } from "../codec-types.js";
import type { BlockRef } from "../handles.js";
import type { LinkShowing } from "../links/shown.js";

export interface ResolvedSpan {
  start: number;
  end: number;
}

/** Inline nodes that replace one plain-text span of a block. */
export interface ResolvedInlineReplacement {
  span: ResolvedSpan;
  /** Inline content applied as given; its text is the replacement's semantic payload. */
  content: Fragment;
}

/** The replacement's plain text, derived from its nodes for semantic IR and output. */
export function inlineReplacementText(replacement: ResolvedInlineReplacement): string {
  return replacement.content.textBetween(0, replacement.content.size, "");
}

/**
 * Resolver → apply seam. Block references are live objects from one local document;
 * a ResolvedEdit must never escape the call that created it or cross process/doc boundaries.
 */
export type ResolvedEdit = { documentId: string; file: string } & (
  | {
      kind: "textRanges";
      block: BlockRef;
      replacements: Array<ResolvedInlineReplacement>;
      /** Semantic projection of the exact replacement window; never used to drive mutation. */
      output: string;
    }
  | {
      kind: "insert";
      after?: BlockRef;
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
  | {
      kind: "block";
      block: BlockRef;
      replacement: Block;
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
}

export type ApplyTransactionOrigin = unknown;

export type ConcurrentUpdateOrigin =
  | AgentOrigin
  | { type: "human"; userId: string }
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
  /** Baseline block hashes explicitly deleted by the attribution kernel. */
  deletedHashes?: {
    human?: readonly string[];
    agent?: readonly string[];
  };
}

export interface ApplyEchoHunk {
  mode: "suppressed" | "truncated" | "full";
  blocks: string[];
}

export interface ConcurrentEditInfo {
  human: string[];
  agent: string[];
  runs: ConcurrentEditRun[];
  /** Set by the request assembler when one or more indivisible runs did not fit. */
  syncOverflow?: boolean;
}

export interface ConcurrentEditRun {
  origin: "human" | "agent" | "mixed" | "concurrent edits";
  /** Full hash-prefixed current prose, anchors and gap blocks included. */
  blocks: string[];
  /** Explicit deletion evidence. A tombstone is never emitted without its captured body. */
  tombstones: Array<{ hash: string; capturedBody: string }>;
  /** Host-only: what this run's rendered blocks showed the model (never in model text). */
  showing?: LinkShowing;
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
