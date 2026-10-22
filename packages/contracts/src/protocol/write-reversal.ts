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
  /** Where it was reversed: live, or a branch's proposal (its text draft or its moves and deletes). */
  destination?: { kind: "live" } | { kind: "draft"; branchId: string };
  status: WriteStatus | TreeReversalFault;
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

/**
 * Why a move or delete couldn't be reversed where it stands now: another document holds its
 * location, its folder is gone, or it was moved or deleted again since. A turn reversal that
 * reversed nothing else answers with it as its status.
 */
export type TreeReversalFault = "location_taken" | "folder_missing" | "superseded";

/** Why one part of a turn reversal stayed, for the app to word. */
export type TurnInverseSkipCause =
  | TreeReversalFault
  /** The destination refused a restore for another reason. */
  | "refused"
  | "rolled_back"
  | "applied"
  | "discarded"
  | "already_undone"
  | "already_redone"
  /** A move or delete whose document was deleted, moved or changed since. */
  | "deleted_since"
  | "moved_since"
  | "changed_since"
  /** Text in a document that is deleted (or discarded) now. */
  | "document_deleted"
  | "document_discarded"
  | "draft_archived"
  | "paragraph_removed"
  | "edited_since"
  /** Text in a document whose restore in the same reversal couldn't run. */
  | "not_restored";

/** A text part, by its excerpts; a move or delete, by the path it was shown at. */
export type TurnInverseSkip = {
  documentId: string;
  uri: string;
  cause: TurnInverseSkipCause;
} & ({ kind: "text"; before: string; after: string } | { kind: "tree"; at: string | null });

export interface ReversalOutcome {
  skips?: TurnInverseSkip[];
  acceptedParts?: number;
  status: WriteStatus | TreeReversalFault;
  documents: DocumentReversalResult[];
  workReceipts?: WorkReversalResult[];
  workError?: "execution_failed";
}
