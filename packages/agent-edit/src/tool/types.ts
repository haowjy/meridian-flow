// LLM-facing write(command=...) contract types for the agent editing core.

import type { ApplyEchoHunk, ConcurrentEditInfo } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";

export type WriteCommandName = "create" | "view" | "insert" | "replace" | "undo" | "redo";

export type ViewFormat = "auto" | "full" | "outline";

interface IdempotentCommand {
  /** Host/tool-call idempotency key. Replays return the original plain-text response. */
  tool_use_id?: string;
}

interface FileCommand extends IdempotentCommand {
  /** Model-facing document path, optionally with a #fragment for view/replace scopes. */
  file: string;
  /** Host-side document identity. Omit only in standalone hosts where file is also the storage key. */
  documentId?: string;
}

export type CreateCommand = FileCommand & {
  command: "create";
  content?: string;
};

export type ViewCommand = FileCommand & {
  command: "view";
  /** Continuation or explicit range (`a1b2..c3d4`, `a1b2..`) for view. */
  in?: string;
  /** Fuzzy view around a block hash. */
  around?: string;
  format?: ViewFormat;
};

export type InsertCommand = FileCommand & {
  command: "insert";
  content: string;
  after?: string;
  before?: string;
  find?: string;
  /** Scope for find-based insert; invalid without find. */
  in?: string;
  around?: string;
  all?: boolean;
};

export type ReplaceCommand = FileCommand & {
  command: "replace";
  /** Replacement text. Empty string is deletion. */
  content: string;
  /** Target block/range without find; search scope with find. */
  in?: string;
  find?: string;
  around?: string;
  all?: boolean;
};

export type UndoCommand = FileCommand & {
  command: "undo";
  /** Single write handle, or range end when from is also set. */
  to?: string;
  /** Inclusive range start; requires to. */
  from?: string;
  last?: number;
  all?: boolean;
};

export type RedoCommand = FileCommand & {
  command: "redo";
  /** Single write handle, or range end when from is also set. */
  to?: string;
  /** Inclusive range start; requires to. */
  from?: string;
  last?: number;
  all?: boolean;
};

export type WriteCommand =
  | CreateCommand
  | ViewCommand
  | InsertCommand
  | ReplaceCommand
  | UndoCommand
  | RedoCommand;

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

export type WriteStatus = "success" | WriteErrorStatus | UndoRedoOutcome;

/** Structured tool result with the exact LLM-facing text kept separate from host status. */
export interface WriteOutcome {
  command: WriteCommandName;
  status: WriteStatus;
  isError: boolean;
  /** Stable model-facing write handle for successful mutating writes, e.g. w3. */
  writeId?: string;
  /** The exact LLM-facing text: status line, echo, concurrent edits, or view content. */
  text: string;
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

export interface ResponseCommitWriteEcho {
  writeId: string;
  hunks: ApplyEchoHunk[];
}

export interface ResponseCommitDocumentResult {
  documentId: string;
  updateCount: number;
  concurrentEdits?: ConcurrentEditInfo;
  /** Adaptive post-commit echoes for staged writes, in original write order; suppressed writes are omitted. */
  echo?: ResponseCommitWriteEcho[];
  /** Exact model-facing text for the post-commit write echoes and concurrent-edit summary. */
  text?: string;
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

export type ReverseScope = "write" | "turn" | "thread";

export interface ReverseInput {
  docId: string;
  threadId: string;
  direction: "undo" | "redo";
  scope: ReverseScope;
  /** writeId for write scope, turnId for turn scope; ignored for thread scope. */
  target?: string;
  actor: { type: "user"; userId: string } | { type: "agent" };
}
