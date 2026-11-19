// Shared write reversal response contracts for context undo APIs.

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "work_archived"
  | "binary_file"
  | "permission_denied"
  | "internal_error";

/**
 * What an undo or revert came to: it changed what it could and says what it left and why
 * (the writer applied it, discarded it, or changed the text since). None of these is an error:
 * the call settled.
 */
export type UndoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "expired"
  | "cant_undo_applied"
  | "cant_undo_discarded"
  | "cant_undo_changed"
  | "purged"
  | "insufficient_undo"
  | "nothing_to_revert";

// Keep in sync with @meridian/agent-edit WriteStatus; do not couple the extractable package to wire contracts.
export type WriteStatus = "success" | "returned" | WriteErrorStatus | UndoOutcome;

/** The statuses of a write that did what it was asked: an undo that took the change back included. */
export const DONE_WRITE_STATUSES = ["success", "reversed", "reconciled"] as const;
export type DoneWriteStatus = (typeof DONE_WRITE_STATUSES)[number];
export const isDoneWriteStatus = (status: string): status is DoneWriteStatus =>
  (DONE_WRITE_STATUSES as readonly string[]).includes(status);

export interface DocumentReversalResult {
  documentId: string;
  uri: string;
  /** Where it was reversed: live, or a branch's proposal (its text draft or its moves and deletes). */
  destination?: { kind: "live" } | { kind: "draft"; branchId: string };
  status: WriteStatus;
  text?: string;
}

export interface WorkReversalResult {
  command: "delete" | "update" | "restore";
  projectId: string;
  workId: string;
  name: string;
  status: "reversed" | "unavailable" | "failed";
  message?: string;
}

export interface ReversalOutcome {
  status: WriteStatus;
  documents: DocumentReversalResult[];
  workReceipts?: WorkReversalResult[];
  workError?: "execution_failed";
}
