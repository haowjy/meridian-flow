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
export interface WriteOutcome {
  command: WriteCommandName;
  status: WriteStatus;
  isError: boolean;
  /** Stable model-facing write handle for successful mutating writes, e.g. w3. */
  writeId?: string;
  /** The exact LLM-facing text: status line, echo, concurrent edits, or read content. */
  text: string;
  /** Multi-block content for structured tool_result. When set, takes priority over text. */
  content?: WriteResultBlock[];
}

export interface InteractionContext {
  /** Full document state at the interaction boundary before the host pulled foreign bytes. */
  baselineSnapshot?: Uint8Array;
  /** Host-specific journal floor captured with the baseline for retry-safe attribution. */
  afterJournalId?: number;
  /** Host-specific branch generation captured with the baseline. */
  branchGeneration?: number;
  /** Durable write attempt id used to exclude this write from concurrent attribution. */
  attemptId?: string;
}

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
}

export interface ResponseStagedCreateOutcome {
  committed: string[];
  discarded: string[];
}

export interface ResponseCommitResult {
  responseId: string;
  documentCount: number;
  updateCount: number;
  documents: ResponseCommitDocumentResult[];
  stagedCreates: ResponseStagedCreateOutcome;
}

export interface ResponseRollbackResult {
  responseId: string;
  stagedCreates: ResponseStagedCreateOutcome;
}
