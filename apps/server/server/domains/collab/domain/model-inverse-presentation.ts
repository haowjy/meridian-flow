/** Model-facing inverse result copy. */

import type { DocumentEditResult } from "@meridian/agent-edit/integration";

type Direction = "undo" | "revert";

export function textPlanRefusal(
  uri: string,
  failure: "draft_archived" | "document_deleted",
): Exclude<DocumentEditResult, { status: "success" }> {
  return failure === "draft_archived"
    ? {
        status: "work_archived",
        message: `This draft is archived. Write to an active draft or live version of ${uri}.`,
      }
    : {
        status: "document_not_found",
        message: "File not found.",
      };
}

export function textOmission(
  handle: string,
  direction: Direction,
  omission: {
    ordinal: number;
    cause: "already_removed" | "compacted" | "draft_archived";
  },
) {
  const words = {
    already_removed: "already removed",
    compacted: "older than the history the document keeps, so it stays",
    draft_archived: "draft archived",
  } as const;
  const fact = `part ${omission.ordinal + 1}: ${words[omission.cause]}`;
  return direction === "revert" ? fact : `${handle} ${fact}`;
}
