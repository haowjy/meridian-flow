/** Branch-backed review wire types for work-draft cards. */

import type { ReviewHunk, ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { DraftReviewOperationInternal } from "./draft-review-types.js";

export type ReviewableDraft = {
  draftId: string;
  documentId: DocumentId;
  workId: WorkId;
  status: "active";
  draftGeneration: number;
  actorThreads: ThreadDraftListItem["actorThreads"];
  updatedAt: Date;
  documentName: string | null;
  contextPath: string | null;
  createdDocument?: boolean;
};

export type DraftReviewPreview = {
  draftId: string;
  draftGeneration: number;
  reviewRoomName: string;
  isNewDocument?: boolean;
  liveRevisionToken: string;
  draftRevisionToken: string;
  operations: DraftReviewOperationInternal[];
  hunks: ReviewHunk[];
  notice?: { code: "branch_corrupt_reset"; message: string };
};

export type DraftApplyResult =
  | { status: "applied"; draftId: string }
  | { status: "not_found"; draftId: string };

export type DraftDiscardResult = {
  status: "discarded" | "stale" | "gone" | "draft_only" | "incomplete_class";
  draftId: string;
  draftClosed?: boolean;
  draftDisposition?: "applied" | "discarded";
};

export { createBranchReviewOperations } from "./branch-review-operations.js";
