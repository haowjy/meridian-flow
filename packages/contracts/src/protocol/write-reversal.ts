// Shared write reversal response contracts for context undo APIs.

import type { ClosedOwnerWhy } from "../commands/index.js";
import type { FileAccessDenial } from "./file-access.js";

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "ambiguous_path"
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

/** A turn reversal that took nothing back: every part it held is a tree change that stayed. */
export type TurnReversalStatus = WriteStatus | "not_undone";

/** A move or restore that committed somewhere other than the recorded destination. */
export type TreeReversalLanding = {
  documentId: string;
  action: "moved" | "restored";
  requestedAt: string;
  landedAt: string;
};

/** Why one part of a turn reversal stayed, for the app to word. */
export type TurnInverseSkipCause =
  | "applied"
  | "discarded"
  | "already_undone"
  /** Text in a document that is deleted (or discarded) now. */
  | "document_deleted"
  | "document_discarded"
  /** The document's owner is closed (Work archived or deleted, chat in Trash): nothing changed; `why` says which. */
  | "returned"
  | "paragraph_removed"
  | "edited_since"
  /** Text in a document whose restore in the same reversal couldn't run. */
  | "not_restored";

/**
 * A text part, by its excerpts; a tree change, by the path it was shown at and what it did. A
 * tree change stayed because a later change holds it (`changed_since`), or its node is purged.
 */
export type TurnInverseSkip = { documentId: string; uri: string } & (
  | {
      kind: "text";
      before: string;
      after: string;
      cause: TurnInverseSkipCause;
      /** Set when `cause` is `returned`. */
      why?: ClosedOwnerWhy;
    }
  | {
      kind: "tree";
      at: string | null;
      op: "create" | "move" | "delete" | "restore";
      cause: "changed_since" | "purged";
    }
);

export interface ReversalOutcome {
  skips?: TurnInverseSkip[];
  landings?: TreeReversalLanding[];
  acceptedParts?: number;
  status: TurnReversalStatus;
  /** Why the file policy refused a `permission_denied` reversal, for the app to word. */
  denial?: FileAccessDenial;
  documents: DocumentReversalResult[];
  workReceipts?: WorkReversalResult[];
  workError?: "execution_failed";
}
