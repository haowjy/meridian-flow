// Shared write reversal response contracts for context undo/redo APIs.

import type { FileAccessDenial } from "./file-access.js";

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
 * What an undo, redo or revert came to: it changed what it could and says what it left and why
 * (the writer applied it, discarded it, or changed the text since). None of these is an error:
 * the call settled.
 */
export type UndoRedoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "expired"
  | "cant_undo_applied"
  | "cant_undo_discarded"
  | "cant_undo_changed"
  | "cant_redo_applied"
  | "cant_redo_discarded"
  | "cant_redo_changed"
  | "cant_redo_users_undo"
  | "insufficient_undo"
  | "insufficient_redo"
  | "nothing_to_revert";

// Keep in sync with @meridian/agent-edit WriteStatus; do not couple the extractable package to wire contracts.
export type WriteStatus = "success" | "returned" | WriteErrorStatus | UndoRedoOutcome;

/** The statuses of a write that did what it was asked: an undo or redo that took the change back included. */
export const DONE_WRITE_STATUSES = ["success", "reversed", "reconciled"] as const;
export type DoneWriteStatus = (typeof DONE_WRITE_STATUSES)[number];
export const isDoneWriteStatus = (status: string): status is DoneWriteStatus =>
  (DONE_WRITE_STATUSES as readonly string[]).includes(status);

export interface DocumentReversalResult {
  documentId: string;
  uri: string;
  /** This reversal removed or restored the document's creation. */
  created?: boolean;
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
 * Why a move or delete couldn't be reversed where it stands now: a document blocks an ancestor
 * folder, its folder is gone, or it was moved or deleted again since. A turn reversal that
 * reversed nothing else answers with it as its status.
 */
export type TreeReversalFault = "ancestor_taken" | "folder_missing" | "superseded";

/** A move or restore that committed somewhere other than the recorded destination. */
export type TreeReversalLanding = {
  documentId: string;
  action: "moved" | "restored";
  requestedAt: string;
  landedAt: string;
};

/** Why one part of a turn reversal stayed, for the app to word. */
export type TurnInverseSkipCause =
  | TreeReversalFault
  /** The destination refused a restore for another reason. */
  | "refused"
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
  landings?: TreeReversalLanding[];
  acceptedParts?: number;
  status: WriteStatus | TreeReversalFault;
  /** Why the file policy refused a `permission_denied` reversal, for the app to word. */
  denial?: FileAccessDenial;
  documents: DocumentReversalResult[];
  workReceipts?: WorkReversalResult[];
  workError?: "execution_failed";
}
