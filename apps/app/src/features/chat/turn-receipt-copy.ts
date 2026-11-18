/** Writer-facing copy for a turn card's reversal outcomes: refusals and the parts that stayed. */
import { t } from "@lingui/core/macro";
import {
  type DoneWriteStatus,
  isDoneWriteStatus,
  type ReversalOutcome,
  type TurnInverseSkip,
} from "@meridian/contracts/protocol";
import { heldSentence, treeLeftSentence } from "@/core/project-tree/tree-left-sentence";
import { GESTURE_DID } from "@/core/project-tree/tree-undo";
import { documentDisplayName } from "./document-display-name";

type TreeSkip = Extract<TurnInverseSkip, { kind: "tree" }>;

/**
 * An Undo the writer asked for and did not get. `not_undone` keeps the one tree change that
 * stayed, and whether it is a folder, to say why as the review row does.
 */
export type ReversalRefusal =
  | {
      status: Exclude<ReversalOutcome["status"], DoneWriteStatus | "not_undone"> | "request_failed";
      /** The file policy's reason, when the status is `permission_denied`. */
      denial?: ReversalOutcome["denial"];
    }
  | { status: "not_undone"; stayed: TreeSkip; folder: boolean };

/** The reversal statuses that mean the manuscript changed as asked. */
export function refusedReversalStatus(
  status: ReversalOutcome["status"],
): Exclude<ReversalOutcome["status"], DoneWriteStatus> | null {
  return isDoneWriteStatus(status) ? null : status;
}

/** Writer-facing copy for a refused reversal. */
export function reversalRefusalCopy(refusal: ReversalRefusal): string {
  switch (refusal.status) {
    case "nothing_to_undo":
      return t`Undo is no longer available.`;
    case "expired":
      return t`This change is no longer reversible.`;
    case "partial":
    case "partial_failure":
      return t`Only part of this change could be reversed.`;
    case "permission_denied":
      return permissionDeniedCopy(refusal.denial);
    case "not_undone":
      return `${t`Not undone.`} ${treeSkipSentence(refusal.stayed, refusal.folder)}`;
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
    case "work_deleted":
      return t`This document's Work was deleted, so this change can't be reversed.`;
    case "not_found":
      return t`This document, or the Work it belongs to, was deleted or isn't available to you, so this change can't be reversed.`;
    default:
      return t`This document can't be edited now, so this change can't be reversed.`;
  }
}

/** Why a tree change the card's Undo left stayed, in the review row's words. */
export function treeSkipSentence(skip: TreeSkip, folder: boolean): string {
  const fact = { did: GESTURE_DID[skip.op], folder };
  return skip.cause === "returned"
    ? heldSentence(fact, skip.why, skip.owner)
    : treeLeftSentence(fact, skip.cause);
}

/** Why one text part of a reversal stayed, beside its excerpts or its document's name. */
export function textSkipCauseCopy(skip: Extract<TurnInverseSkip, { kind: "text" }>): string {
  switch (skip.cause) {
    case "applied":
      return t`Already applied`;
    case "discarded":
      return t`Discarded`;
    case "already_undone":
      return t`Taken out`;
    case "document_deleted":
      return t`This document was deleted`;
    case "document_discarded":
      return t`This document was discarded from the draft`;
    case "returned":
      return heldSentence(
        { did: null, folder: false, name: documentDisplayName(skip.uri) },
        skip.why,
        undefined,
      );
    case "paragraph_removed":
      return t`Its paragraph was removed`;
    case "edited_since":
      return t`Stayed as you edited it`;
    case "not_restored":
      return t`Its document wasn't restored`;
  }
}
