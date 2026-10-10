/** Branch-backed review wire types for work-draft cards. */

import type { DocumentId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { ApplyItemResult, HeldReason } from "./draft-publication.js";
import type { DraftReviewItem } from "./draft-review-items.js";
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
  /** The item as this preview rendered it, its text tokens from this cut; absent when the branch isn't an item. */
  item?: DraftReviewItem;
};

/** The legacy per-document Apply; `draftId` is the branch id the request named. */
export type DraftApplyResult =
  | { status: "applied"; draftId: string; item: Extract<ApplyItemResult, { status: "applied" }> }
  | { status: "held"; draftId: string; reason: HeldReason }
  | { status: "stale"; draftId: string }
  | { status: "not_found"; draftId: string };

export type DraftDiscardResult = { status: "discarded"; draftId: string };

export { createBranchReviewOperations } from "./branch-review-operations.js";
