// LLM-facing write(command=...) contract types for the agent editing core.

import type { WriteStatus } from "@meridian/contracts/protocol";
import type { z } from "zod";
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { WriteCommandSchema } from "./command-schema.js";
import type { WriteResultBlock } from "./internal-result.js";

export type { UndoRedoOutcome, WriteErrorStatus, WriteStatus } from "@meridian/contracts/protocol";
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
