/** Branch-backed review wire types for work-draft cards. */

import type { DocumentId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

export type ReviewableDraft = {
  draftId: string;
  documentId: DocumentId;
  workId: WorkId;
  status: "active";
  lastActorTurnId: TurnId | null;
  updatedAt: Date;
  documentName: string | null;
  contextPath: string | null;
  wordsAdded: number | null;
  wordsRemoved: number | null;
  createdDocument?: boolean;
};

export type ActiveDraft = ReviewableDraft;

export type DraftReviewPreview = {
  draftId: string;
  reviewRoomName: string;
  live: string;
  markdown: string;
  isNewDocument?: boolean;
  liveRevisionToken: number;
  draftRevisionToken: number;
  inlineModelPresent: true;
  operations: DraftReviewOperationInternal[];
  hunks: DraftReviewHunkInternal[];
  notice?: { code: "branch_corrupt_reset"; message: string };
};

export type DraftApplyResult =
  | { status: "applied"; draftId: string }
  | { status: "discarded"; draftId: string }
  | { status: "not_found"; draftId: string };

export type DraftDiscardResult = { status: "discarded"; draftId: string };

export { createBranchReviewOperations } from "./branch-review-operations.js";
