/** Writer-facing copy for a turn card's reversal outcomes: refusals and the parts that stayed. */
import { t } from "@lingui/core/macro";
import type {
  ReversalOutcome,
  TreeReversalFault,
  TurnInverseSkip,
  TurnInverseSkipCause,
} from "@meridian/contracts/protocol";
import type { ReversalDirection } from "@/client/api/reverse-api";
import { documentLocationName, type OwnerNames } from "./document-display-name";

type SuccessfulReversalStatus = "success" | "reversed" | "reconciled";

/**
 * A reversal the writer asked for and did not get, plus the direction they asked in: the
 * direction the receipt carries can flip under a refusal, and the copy has to name the command
 * pressed. A tree fault keeps the location it met, when the server reported one.
 */
export type ReversalRefusal = {
  direction: ReversalDirection;
  status: Exclude<ReversalOutcome["status"], SuccessfulReversalStatus> | "request_failed";
  at?: string | null;
};

/** The reversal statuses that mean the manuscript changed as asked. */
export function refusedReversalStatus(
  status: ReversalOutcome["status"],
): ReversalRefusal["status"] | null {
  if (status === "success" || status === "reversed" || status === "reconciled") return null;
  return status;
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
    case "nothing_to_redo":
      return t`Redo is no longer available because the manuscript changed.`;
    case "nothing_to_undo":
      return t`Undo is no longer available.`;
    case "cant_undo_dependent":
      return dependentChangeCopy();
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
      return t`This document's Work is archived. Unarchive the Work to reverse this change.`;
    case "location_taken":
    case "folder_missing":
    case "superseded":
      return treeFaultCopy(refusal.status, refusal.direction, refusal.at ?? null, names);
    case "internal_error":
    case "region_changed":
    case "request_failed":
      return reversalRetryCopy(refusal.direction);
    default: {
      // Model-only refusal codes do not drive writer controls. Unknown
      // statuses keep the existing retry path.
      return reversalRetryCopy(refusal.direction);
    }
  }
}

/**
 * A move or delete that met its destination unable to take it back, naming the command and the
 * whole place, so the writer can find it. "Taken" doesn't say by what: a document or a folder.
 */
function treeFaultCopy(
  fault: TreeReversalFault,
  direction: ReversalDirection,
  at: string | null,
  names: OwnerNames | undefined,
): string {
  const place = at ? documentLocationName(at, names) : null;
  const redo = direction === "redo";
  switch (fault) {
    case "location_taken":
      if (place)
        return redo
          ? t`Can't redo: ${place} is already taken. Move or rename what's there, then try again.`
          : t`Can't undo: ${place} is already taken. Move or rename what's there, then try again.`;
      return redo
        ? t`Can't redo: its location is already taken. Move or rename what's there, then try again.`
        : t`Can't undo: its location is already taken. Move or rename what's there, then try again.`;
    case "folder_missing":
      return redo
        ? t`Can't redo: the folder it would move to is gone.`
        : t`Can't undo: the folder it would return to is gone.`;
    case "superseded":
      if (place)
        return redo
          ? t`Can't redo: ${place} was moved or deleted after you undid this change.`
          : t`Can't undo: ${place} was moved or deleted after this change.`;
      return redo
        ? t`Can't redo: the document was moved or deleted after you undid this change.`
        : t`Can't undo: the document was moved or deleted after this change.`;
  }
}

/** The one sentence for "later live edits depend on this", wherever it surfaces. */
export function dependentChangeCopy(): string {
  return t`Later edits build on this change, so it can't be reversed. View the change instead.`;
}

function reversalRetryCopy(direction: ReversalDirection): string {
  return direction === "redo"
    ? t`Redo didn't go through. Try again.`
    : t`Undo didn't go through. Try again.`;
}

/** Why one part of a reversal stayed, beside its excerpts or its document's name. */
export function skipCauseCopy(cause: TurnInverseSkipCause): string {
  switch (cause) {
    case "location_taken":
      return t`Its location is taken`;
    case "folder_missing":
      return t`Its folder is gone`;
    case "superseded":
      return t`Moved or deleted after this change`;
    case "refused":
      return t`Couldn't be reversed`;
    case "rolled_back":
      return t`Rolled back`;
    case "applied":
      return t`Applied to the manuscript`;
    case "discarded":
      return t`Discarded`;
    case "already_undone":
      return t`Already undone`;
    case "already_redone":
      return t`Already redone`;
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
    case "draft_archived":
      return t`This draft is archived`;
    case "paragraph_removed":
      return t`Its paragraph was removed`;
    case "edited_since":
      return t`Stayed as you edited it`;
    case "not_restored":
      return t`Its document wasn't restored`;
  }
}
