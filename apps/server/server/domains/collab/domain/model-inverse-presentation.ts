/** Model-facing inverse result copy. */

import type { DocumentEditResult } from "@meridian/agent-edit/integration";

type Direction = "undo" | "redo" | "revert";

export function textPlanRefusal(
  uri: string,
  handle: string,
  direction: Direction,
  failure:
    | "draft_archived"
    | "document_deleted"
    | "applied"
    | "partly_applied"
    | "discarded"
    | "changed",
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
  if (failure === "applied")
    return {
      status: `cant_${verb}_applied`,
      message: `The user applied ${handle} to the manuscript, and its draft is closed. Read ${uri} and make a new replace.`,
    };
  if (failure === "partly_applied")
    return {
      status: `cant_${verb}_applied`,
      message: `The user applied part of ${handle} to the manuscript and discarded the rest, and its draft is closed. Read ${uri} and make a new replace for what is still missing.`,
    };
  return failure === "discarded"
    ? {
        status: `cant_${verb}_discarded`,
        message: `The user discarded ${handle}; it is already gone. Read ${uri} and make a new replace if it is still wanted.`,
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
