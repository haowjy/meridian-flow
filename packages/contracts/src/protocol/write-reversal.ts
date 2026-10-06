// Shared write reversal response contracts for context undo/redo APIs.

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "cant_undo_dependent"
  | "read_required"
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

/**
 * A turn undo or redo refused because a create, move or delete can't go back
 * or again: another document is at its location, or the folder it was in is
 * gone. `uri` names the location.
 */
export type TreeReversalStatus = "location_taken" | "folder_missing";

export interface DocumentReversalResult {
  uri: string;
  status: WriteStatus | TreeReversalStatus;
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

export interface ReversalOutcome {
  status: WriteStatus | TreeReversalStatus;
  documents: DocumentReversalResult[];
  workReceipts?: WorkReversalResult[];
  workError?: "execution_failed";
}
