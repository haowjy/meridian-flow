/** Model-facing inverse result copy. */

import type { DocumentEditResult } from "@meridian/agent-edit/integration";
import type { InverseDestination } from "./inverse-draft-destination.js";
import type { InverseStep } from "./inverse-stream.js";
import { type TreeInverseRefused, treeFaultReason } from "./tree-inverse.js";
import type { InverseDocument } from "./turn-inverse-service.js";

/** The capture-owned destination a dry result presents for a planned step. */
export function plannedStepDestination(
  document: InverseDocument,
  step: InverseStep,
): InverseDestination {
  if (step.kind === "text") return step.destination;
  if (step.planned.entry.tree.op === "create")
    return document.destinationForCreate(step.planned.entry);
  if (step.planned.destination.kind === "live")
    return document.destinationOf({ kind: "live", seq: 0 });
  const branchId = step.planned.destination.branchId;
  const draftId = document.occupancy(branchId);
  return draftId
    ? document.destinationOf({ kind: "pending", draftId, rowId: 0 })
    : { kind: "draft", branchId, state: "gone" };
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
