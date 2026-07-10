/** Branch-backed review wire types for work-draft cards. */

import type { DocumentId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

export type ReviewableDraft = {
  id: string;
  documentId: DocumentId;
  workId: WorkId;
  status: "active" | "closed";
  branchId?: string;
  generation?: number;
  lastActorTurnId: TurnId | null;
  appliedAt: Date | null;
  discardedAt: Date | null;
  undoneAt: Date | null;
  updatedAt: Date;
  documentName: string | null;
  contextPath: string | null;
  wordsAdded: number | null;
  wordsRemoved: number | null;
  createdDocument?: boolean;
};

export type ActiveDraft = ReviewableDraft & { status: "active" };

export type DraftJournalSnapshot = {
  draftRevisionToken: number;
  updates: Array<{
    id: number;
    updateData: Uint8Array;
    actorTurnId: TurnId | null;
    actorUserId: UserId | null;
    updateKind?: string | null;
  }>;
};

export type DraftReviewPreview = {
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

export type DraftAcceptResult =
  | { status: "stale_draft"; draftId: string; draftRevisionToken: number }
  | { status: "applied"; draftId: string; branchId?: string; appliedUpdateSeq: number }
  | {
      status: "partial_applied";
      draftId: string;
      appliedUpdateSeq: number;
      acceptedOperationIds: string[];
      writeId: string;
    }
  | { status: "discarded"; draftId: string; branchId?: string }
  | { status: "not_found"; draftId: string };

export type DraftRejectResult = { status: "discarded"; draftId: string; branchId?: string };
