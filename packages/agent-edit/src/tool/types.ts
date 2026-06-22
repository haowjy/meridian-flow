// LLM-facing write(command=...) contract types for the agent editing core.
import type { ActorSession } from "../ports/actor-session-store.js";

export type WriteCommandName = "create" | "view" | "insert" | "replace" | "undo" | "redo";

export type ViewFormat = "auto" | "full" | "outline";

interface IdempotentCommand {
  /** Host/tool-call idempotency key. Replays return the original plain-text response. */
  tool_use_id?: string;
}

interface FileCommand extends IdempotentCommand {
  /** Document path within the project, optionally with a #fragment for view/replace scopes. */
  file: string;
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
  last?: number;
  all?: boolean;
};

export type RedoCommand = FileCommand & {
  command: "redo";
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
}

export type WriteFunction = (
  command: WriteCommand,
  context?: WriteContext,
) => Promise<WriteOutcome>;
