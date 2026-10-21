// Shared write reversal response contracts for context undo/redo APIs.

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "ambiguous_path"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "cant_undo_dependent"
  | "cant_undo_applied"
  | "cant_undo_discarded"
  | "cant_undo_changed"
  | "cant_undo_elsewhere"
  | "cant_redo_applied"
  | "cant_redo_discarded"
  | "cant_redo_changed"
  | "cant_redo_elsewhere"
  | "cant_redo_users_undo"
  | "insufficient_undo"
  | "insufficient_redo"
  | "nothing_to_revert"
  | "work_archived"
  | "region_changed"
  | "binary_file"
  | "permission_denied"
  | "internal_error";

export type UndoRedoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "expired";

// Keep in sync with @meridian/agent-edit WriteStatus; do not couple the extractable package to wire contracts.
export type WriteStatus = "success" | WriteErrorStatus | UndoRedoOutcome;

export interface DocumentReversalResult {
  uri: string;
  destination?: { kind: "live" } | { kind: "draft"; draftId: string };
  status: WriteStatus;
  text?: string;
}

export interface WorkReversalResult {
  command: "delete" | "update" | "restore";
  projectId: string;
  workId: string;
  name: string;
  status: "reversed" | "redone" | "unavailable" | "already_applied" | "failed";
  message?: string;
}

export interface TurnInverseSkip {
  documentId: string;
  uri: string;
  before: string;
  after: string;
  reason: string;
}

export interface ReversalOutcome {
  skips?: TurnInverseSkip[];
  acceptedParts?: number;
  status: WriteStatus;
  documents: DocumentReversalResult[];
  workReceipts?: WorkReversalResult[];
  workError?: "execution_failed";
}
