// LLM-facing write(command=...) contract types for the agent editing core.

import type { z } from "zod";
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { WriteCommandSchema } from "./command-schema.js";
import type { WriteResultBlock } from "./internal-result.js";

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "cant_undo_dependent"
  | "destructive_write_rejected"
  | "rejected_response_requires_reread"
  | "internal_error";

export type UndoRedoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "expired";

// Keep in sync with @meridian/contracts/protocol WriteStatus; agent-edit must stay host-agnostic.
export type WriteStatus = "success" | WriteErrorStatus | UndoRedoOutcome;
export type { WriteResultBlock };

export type WriteCommand = z.infer<typeof WriteCommandSchema>;
export type WriteCommandName = WriteCommand["command"];
export type CreateCommand = Extract<WriteCommand, { command: "create" }>;
export type ReadCommand = Extract<WriteCommand, { command: "read" }>;
export type InsertCommand = Extract<WriteCommand, { command: "insert" }>;
export type ReplaceCommand = Extract<WriteCommand, { command: "replace" }>;
export type UndoCommand = Extract<WriteCommand, { command: "undo" }>;
export type RedoCommand = Extract<WriteCommand, { command: "redo" }>;
export type ReadFormat = ReadCommand["format"];
export type QueryWriteCommand = ReadCommand;
export type MutatingWriteCommand = CreateCommand | InsertCommand | ReplaceCommand;
export type HistoryWriteCommand = UndoCommand | RedoCommand;

/** Structured tool result with the exact LLM-facing text kept separate from host status. */
export type WriteOutcome = WriteOutcomeBase &
  ({ status: "success"; phase: WriteSuccessPhase } | { status: Exclude<WriteStatus, "success"> });

export type WriteSuccessPhase = "staged" | "committed";

interface WriteOutcomeBase {
  command: WriteCommandName;
  isError: boolean;
  /** Stable model-facing write handle for successful mutating writes, e.g. w3. */
  writeId?: string;
  /** Machine-readable error detail for host observability; model-facing text remains in `text`. */
  error?: WriteErrorDetail;
  /** The exact LLM-facing text: status line, echo, concurrent edits, or read content. */
  text: string;
  /** Multi-block content for structured tool_result. When set, takes priority over text. */
  content?: WriteResultBlock[];
}

export type ResponseLifecycleOperation = "stage" | "commit" | "rollback";
export type ResponseLifecycleClosedState = "committed" | "rolledBack" | "rejected";

export interface ResponseLifecycleErrorDetail {
  type: "response_lifecycle";
  code: "response_closed";
  responseId: string;
  operation: ResponseLifecycleOperation;
  state: ResponseLifecycleClosedState;
  documentId?: string;
  threadId?: string;
  turnId?: string;
  writeId?: string;
}

/**
 * A mutation-bearing write claimed for a document was dropped from an open
 * response (writer-discarded card / thread invalidation) while other docs in
 * the same response stayed staged and eventually committed. The model already
 * saw `tool_result status: "success"` for the dropped write; this event makes
 * the non-durability loud alongside the durable commit of the survivors.
 */
export interface ResponseClaimDiscardedEntry {
  documentId: string;
  threadId: string;
  updateCount: number;
}

export interface ResponseLifecycleClaimDiscardedDetail {
  type: "response_lifecycle";
  code: "claimed_write_discarded";
  responseId: string;
  documents: readonly ResponseClaimDiscardedEntry[];
}

/** Host observability when a tool_use_id replay returns a cached write outcome. */
export interface WriteIdempotencyHitDetail {
  toolUseId: string;
  scopeKind: "response" | "turn" | null;
  scopeId: string | null;
  sessionId: string;
  outcome:
    | { status: "success"; phase: WriteSuccessPhase }
    | { status: Exclude<WriteStatus, "success"> };
}

export type ResponseLifecycleEvent =
  | ResponseLifecycleErrorDetail
  | ResponseLifecycleClaimDiscardedDetail;

export type ResponseCommitterPhase = "buffered" | "journalCommitted" | "liveProjected" | "closed";

export type ResponseCommitterTransition =
  | "stage"
  | "drop_for_thread"
  | "journal_committed"
  | "live_projected"
  | "closed"
  | "rollback"
  | "recovery_succeeded"
  | "recovery_failed"
  | "evicted";

export interface ResponseCommitterTransitionDetail {
  type: "response_committer";
  transition: ResponseCommitterTransition;
  responseId: string;
  phase: ResponseCommitterPhase;
  journalCommitKind?: import("../ports/update-journal.js").JournalCommitKind;
  closedOutcome?: ResponseLifecycleClosedState;
  documentId?: string;
  threadId?: string;
  droppedUpdateCount?: number;
}

export type WriteErrorDetail = ResponseLifecycleErrorDetail;

interface InteractionContextBase {
  /** Full document state at the interaction boundary before the host pulled foreign bytes. */
  baselineSnapshot?: Uint8Array;
  /** Host-specific journal floor captured with the baseline for retry-safe attribution. */
  afterJournalId?: number;
  /** Live Yjs journal sequence captured with the baseline for reconstruction receipts. */
  liveJournalSeq?: number;
  /** Durable write attempt id used to exclude this write from concurrent attribution. */
  attemptId?: string;
}

export type InteractionContext =
  | (InteractionContextBase & {
      /** Live writes have no branch-generation fence by type. */
      mode: "live";
    })
  | (InteractionContextBase & {
      /** Thread-peer writes must carry the branch-generation fence captured with the baseline. */
      mode: "threadPeer";
      branchGeneration: number;
    });

/** Hidden host/session context; not part of the LLM command params. */
export interface WriteContext {
  /** Stable session supplied directly by embedded callers. */
  session?: ActorSession;
  /** External identity resolved through ActorSessionStore when configured. */
  externalId?: string;
  /** Convenience identity for server-local callers that do not need an ActorSessionStore. */
  sessionId?: string;
  /** Convenience thread override for server-local callers. */
  threadId?: string;
  /** Host turn id for undo metadata; cross-call turn grouping is completed above this API later. */
  turnId?: string;
  /** Host/tool-call idempotency key. Replays return the original plain-text response. */
  tool_use_id?: string;
  /** Host model-response id. Mutating writes buffer until commitResponse when set. */
  responseId?: string;
  /**
   * Host-captured interaction identity: baseline, journal floor, branch
   * generation, and optional attempt guard travel as one object.
   */
  interactionContext?: InteractionContext;
  /** True only when the host resolved this create to a previously missing document. */
  createdDocument?: boolean;
}

export type WriteFunction = (
  command: WriteCommand,
  context?: WriteContext,
) => Promise<WriteOutcome>;

export type UndoResult = WriteOutcome & { command: "undo" };
export type RedoResult = WriteOutcome & { command: "redo" };
export type WriteUndoResult = UndoResult;
export type WriteRedoResult = RedoResult;
export type TurnUndoResult = UndoResult;
export type TurnRedoResult = RedoResult;

export interface ResponseCommitDocumentResult {
  documentId: string;
  updateCount: number;
  concurrentEdits?: ConcurrentEditInfo;
  lateSweep?: import("./mutation-commit.js").DestructiveSweepReport;
}

export interface ResponseStagedCreateOutcome {
  committed: string[];
  discarded: string[];
}

export interface ResponseCommitSuccessResult {
  status: "committed";
  responseId: string;
  documentCount: number;
  updateCount: number;
  documents: ResponseCommitDocumentResult[];
  stagedCreates: ResponseStagedCreateOutcome;
  /** Recovery committed the journal but could not verify concurrent-content awareness. */
  awarenessDegraded?: boolean;
  /**
   * Mutation-bearing writes the model was already told succeeded, dropped
   * before commit by a per-doc `dropForThread`, while other docs in this
   * response committed durably. Always non-empty when the
   * `claimed_write_discarded` lifecycle event fires.
   */
  discardedClaims?: readonly ResponseClaimDiscardedEntry[];
}

export interface ResponseCommitDocumentRejection {
  documentId: string;
  conflictedBlockHashes: readonly string[];
  affectedWriteIds: readonly string[];
}

export interface ResponseCommitRejectedResult {
  status: "rejected";
  responseId: string;
  rejections: ResponseCommitDocumentRejection[];
}

export type ResponseCommitResult = ResponseCommitSuccessResult | ResponseCommitRejectedResult;

export interface ResponseRollbackResult {
  responseId: string;
  stagedCreates: ResponseStagedCreateOutcome;
}
