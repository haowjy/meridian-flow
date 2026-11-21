/** Model-facing inverse result copy. */

import type { DocumentEditResult } from "@meridian/agent-edit/integration";

type Direction = "undo" | "revert";

export function textPlanRefusal(
  uri: string,
  handle: string,
  failure: "draft_archived" | "document_deleted" | "changed",
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
  return {
    status: `cant_undo_changed`,
    message: `Can't undo ${handle}: none of that edit remains unchanged. Nothing was changed in ${uri}.`,
  };
}

export function textOmission(
  handle: string,
  direction: Direction,
  omission: {
    ordinal: number;
    cause: "already_removed" | "edited_since" | "draft_archived";
  },
) {
  const words = {
    already_removed: "already removed",
    edited_since: "edited since",
    draft_archived: "draft archived",
  } as const;
  const fact = `part ${omission.ordinal + 1}: ${words[omission.cause]}`;
  return direction === "revert" ? fact : `${handle} ${fact}`;
}
