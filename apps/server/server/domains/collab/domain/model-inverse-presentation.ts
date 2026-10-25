/** Model-facing inverse result copy. */

import type { DocumentEditResult } from "@meridian/agent-edit/integration";
import type { InverseDestination } from "./inverse-draft-destination.js";
import type { InverseStep } from "./inverse-stream.js";
import { type TreeInverseRefused, treeFaultReason } from "./tree-inverse.js";
import type { InverseDocument } from "./turn-inverse-service.js";

type Direction = "undo" | "redo" | "revert";

export function textPlanRefusal(
  uri: string,
  handle: string,
  direction: Direction,
  failure: "draft_archived" | "document_deleted" | "discarded" | "changed",
): Exclude<DocumentEditResult, { status: "success" }> {
  if (failure === "draft_archived")
    return {
      status: "work_archived",
      message: `This draft is archived. Write to an active draft or live version of ${uri}.`,
    };
  if (failure === "document_deleted")
    return {
      status: "document_not_found",
      message: "File not found. Read the project to find the right path.",
    };
  const verb = direction === "revert" ? "undo" : direction;
  const follow = `Use revert on ${uri}, or read it and make a new replace.`;
  return failure === "discarded"
    ? {
        status: `cant_${verb}_discarded`,
        message: `The user discarded ${handle}; it is already gone. ${follow}`,
      }
    : {
        status: `cant_${verb}_changed`,
        message: `Can't ${verb} ${handle}: none of that edit remains unchanged. Read ${uri} for current text.`,
      };
}

export function textOmission(
  handle: string,
  direction: Direction,
  omission: {
    ordinal: number;
    cause:
      | "paragraph_removed"
      | "already_removed"
      | "edited_since"
      | "draft_archived"
      | "discarded"
      | "rolled_back";
  },
) {
  const words = {
    paragraph_removed: "paragraph replaced or removed",
    already_removed: "already removed",
    edited_since: "edited since",
    draft_archived: "draft archived",
    discarded: "discarded",
    rolled_back: "rolled back",
  } as const;
  const fact = `part ${omission.ordinal + 1}: ${words[omission.cause]}`;
  return direction === "revert" ? fact : `${handle} ${fact}`;
}

export function treePlanRefusal(
  uri: string,
  handle: string,
  direction: Direction,
  cause: import("@meridian/contracts/protocol").TurnInverseSkipCause,
): Exclude<DocumentEditResult, { status: "success" }> {
  const verb = direction === "revert" ? "undo" : direction;
  const follow = "Check where it is with `ls`, then make a new move or delete if needed.";
  if (cause === "draft_archived")
    return {
      status: "work_archived",
      message: `This draft is archived. Write to an active draft or live version of ${uri}.`,
    };
  if (cause === "applied" || cause === "discarded")
    return {
      status: `cant_${verb}_${cause}`,
      message:
        cause === "applied"
          ? `The user applied ${handle} to the manuscript. ${follow}`
          : `The user discarded ${handle}; it is already gone. ${follow}`,
    };
  return {
    status: `cant_${verb}_changed`,
    message: `${handle} can't be ${verb === "undo" ? "undone" : "redone"}: the document changed after you ${verb === "undo" ? "made" : "undid"} it. ${follow}`,
  };
}

/** The capture-owned destination a dry result presents for a planned step. */
export function plannedStepDestination(
  document: InverseDocument,
  step: InverseStep,
): InverseDestination {
  if (step.kind === "text") return step.destination;
  if (step.planned.destination.kind === "live")
    return document.destinationOf({ kind: "live", seq: 0 });
  return document.destinationForBranch(step.planned.destination.branchId);
}

/** A tree inverse the destination refused under the locks: nothing of the command ran. */
export function treeRefusal(cause: TreeInverseRefused): DocumentEditResult {
  const verb = cause.planned.direction === "invert" ? "undo" : "redo";
  const what =
    cause.fault === "ancestor_taken"
      ? `a document blocks the folder path to ${cause.at ?? "its destination"}. Move that document out of the way, then retry.`
      : cause.fault === "folder_missing"
        ? "the destination folder is gone. Tell the user this change can't be reversed here."
        : `${treeFaultReason(cause.fault)}. Tell the user this change can't be reversed here.`;
  return {
    status: `cant_${verb}_changed`,
    message: `Can't ${verb} ${cause.planned.entry.tree.shownAt ?? "this change"}: ${what}`,
  };
}
