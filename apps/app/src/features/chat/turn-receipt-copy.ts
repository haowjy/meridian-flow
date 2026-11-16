/** Writer-facing copy for a turn card's reversal outcomes: refusals and the parts that stayed. */
import { t } from "@lingui/core/macro";
import {
  type DoneWriteStatus,
  isDoneWriteStatus,
  type ReversalOutcome,
  type TreeReversalFault,
  type TurnInverseSkip,
} from "@meridian/contracts/protocol";
import { documentLocationName, type OwnerNames } from "./document-display-name";

/** An Undo the writer asked for and did not get. A tree fault keeps the location it met, when the server reported one. */
export type ReversalRefusal = {
  status: Exclude<ReversalOutcome["status"], DoneWriteStatus> | "request_failed";
  at?: string | null;
  /** The file policy's reason, when the status is `permission_denied`. */
  denial?: ReversalOutcome["denial"];
};

/** The reversal statuses that mean the manuscript changed as asked. */
export function refusedReversalStatus(
  status: ReversalOutcome["status"],
): ReversalRefusal["status"] | null {
  return isDoneWriteStatus(status) ? null : status;
}

/** The location a tree fault met, from the skip that reported it. */
export function treeFaultLocation(
  status: ReversalRefusal["status"],
  skips: readonly TurnInverseSkip[] | undefined,
): string | null {
  const skip = skips?.find((candidate) => candidate.kind === "tree" && candidate.cause === status);
  return skip?.kind === "tree" ? skip.at : null;
}

/** Writer-facing copy for a refused reversal. */
export function reversalRefusalCopy(refusal: ReversalRefusal, names?: OwnerNames): string {
  switch (refusal.status) {
    case "nothing_to_undo":
      return t`Undo is no longer available.`;
    case "expired":
      return t`This change is no longer reversible.`;
    case "partial":
    case "partial_failure":
      return t`Only part of this change could be reversed.`;
    case "not_found":
    case "document_not_found":
      return t`That document is no longer available, so this change can't be reversed.`;
    case "ambiguous_match":
    case "invalid_write":
      return t`This change no longer matches the document's text, so it can't be reversed.`;
    case "binary_file":
      return t`This file is binary, so this change can't be reversed.`;
    case "permission_denied":
      return permissionDeniedCopy(refusal.denial);
    case "ancestor_taken":
    case "folder_missing":
    case "superseded":
      return treeFaultCopy(refusal.status, refusal.at ?? null, names);
    default:
      // Model-only refusal codes do not drive writer controls. Unknown statuses, an internal
      // error and a lost request keep the retry path.
      return t`Undo didn't go through. Try again.`;
  }
}

function permissionDeniedCopy(denial: ReversalOutcome["denial"]): string {
  switch (denial) {
    case "work_archived":
      return t`This document's Work is archived. Unarchive the Work to reverse this change.`;
    case "chat_frozen":
      return t`This document's chat was deleted. Restore the chat to reverse this change.`;
    case "not_found":
      return t`This document, or the Work it belongs to, was deleted or isn't available to you, so this change can't be reversed.`;
    default:
      return t`This document can't be edited now, so this change can't be reversed.`;
  }
}

/**
 * A move or delete that met its destination unable to take it back, naming the whole place, so
 * the writer can find it. "Taken" doesn't say by what: a document or a folder.
 */
function treeFaultCopy(
  fault: TreeReversalFault,
  at: string | null,
  names: OwnerNames | undefined,
): string {
  const place = at ? documentLocationName(at, names) : null;
  switch (fault) {
    case "ancestor_taken":
      return place
        ? t`Can't undo: a document blocks the folder path to ${place}. Move it, then try again.`
        : t`Can't undo: a document blocks its folder path. Move it, then try again.`;
    case "folder_missing":
      return t`Can't undo: the folder it would return to is gone.`;
    case "superseded":
      return place
        ? t`Can't undo: ${place} was moved or deleted after this change.`
        : t`Can't undo: the document was moved or deleted after this change.`;
  }
}

/** Why one part of a reversal stayed, beside its excerpts or its document's name. */
export function skipCauseCopy(skip: Pick<TurnInverseSkip, "cause" | "why">): string {
  switch (skip.cause) {
    case "ancestor_taken":
      return t`A document blocks its folder path`;
    case "folder_missing":
      return t`Its folder is gone`;
    case "superseded":
      return t`Moved or deleted after this change`;
    case "refused":
      return t`Couldn't be reversed`;
    case "applied":
      return t`Applied to the manuscript`;
    case "discarded":
      return t`Discarded`;
    case "already_undone":
      return t`Taken out`;
    case "deleted_since":
      return t`Deleted since`;
    case "moved_since":
      return t`Moved since`;
    case "changed_since":
      return t`Changed since`;
    case "document_deleted":
      return t`This document was deleted`;
    case "document_discarded":
      return t`This document was discarded from the draft`;
    case "returned":
      return skip.why === "chat_frozen"
        ? t`Its chat is in Trash, so this stayed as it is`
        : t`Its Work was closed, so this stayed as it is`;
    case "paragraph_removed":
      return t`Its paragraph was removed`;
    case "edited_since":
      return t`Stayed as you edited it`;
    case "not_restored":
      return t`Its document wasn't restored`;
  }
}
