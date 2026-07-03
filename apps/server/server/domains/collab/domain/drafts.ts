/** Draft review persistence types and lifecycle store contracts for collab documents. */
import { randomBytes } from "node:crypto";
import type { WIdRange } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";

export type DraftStatus = "active" | "accepting" | "reactivating" | "applied" | "discarded";

export type Draft = {
  id: string;
  documentId: DocumentId;
  workId: WorkId;
  status: DraftStatus;
  baseLiveUpdateSeq: number;
  acceptGeneration: number;
  createdDocument: boolean;
  lastActorTurnId: TurnId | null;
  appliedAt: Date | null;
  appliedByUserId: UserId | null;
  appliedUpdateSeq: number | null;
  discardedAt: Date | null;
  undoneAt: Date | null;
  claimedAt: Date | null;
  claimToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActiveDraft = Draft & {
  status: "active";
  documentName: string | null;
  contextPath: string | null;
};
export type ReviewableDraft = Draft & {
  status: "active" | "applied" | "discarded";
  documentName: string | null;
  contextPath: string | null;
};

export type DraftLifecycleEvent = {
  draftId: string;
  documentId: DocumentId;
  documentName: string | null;
  status: "applied" | "discarded" | "undone";
  occurredAt: Date;
};

export type DraftTurnContext = {
  documentName: string | null;
  wIdRange: WIdRange | null;
};

export type DraftUpdate = {
  id: number;
  draftId: string;
  updateData: Uint8Array;
  actorUserId: UserId | null;
  actorTurnId: TurnId | null;
  createdAt: Date;
};

export function createDraftId(now = Date.now()): string {
  return `${encodeUlidTime(now)}${encodeUlidRandom()}`;
}

export class ActiveDraftConflictError extends Error {
  readonly documentId: DocumentId;
  readonly threadId: ThreadId;

  constructor(input: { documentId: DocumentId; threadId: ThreadId }) {
    super(
      `Active draft already exists for document ${input.documentId} and thread ${input.threadId}`,
    );
    this.name = "ActiveDraftConflictError";
    this.documentId = input.documentId;
    this.threadId = input.threadId;
  }
}

export type DraftStore = {
  resolveWorkId(threadId: ThreadId): Promise<WorkId | null>;
  getDraft(draftId: string): Promise<Draft | null>;
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  getActiveDraftByWork(input: { documentId: DocumentId; workId: WorkId }): Promise<Draft | null>;
  resolveDraftThreadId(draftId: string): Promise<ThreadId | null>;
  resolvePrimaryThreadForWork(workId: WorkId): Promise<ThreadId | null>;
  draftTurnContext(draftId: string): Promise<DraftTurnContext | null>;
  listActiveDrafts(input: { threadId: ThreadId }): Promise<ActiveDraft[]>;
  listReviewableDrafts(input: { threadId: ThreadId }): Promise<ReviewableDraft[]>;
  listReviewableDraftsByWork(input: { workId: WorkId }): Promise<ReviewableDraft[]>;
  listActiveDraftsByWork(input: { workId: WorkId }): Promise<ActiveDraft[]>;
  listLifecycleEventsByWorkSince(input: {
    workId: WorkId;
    since: Date | null;
  }): Promise<DraftLifecycleEvent[]>;
  discardFailedResponseDrafts(input: {
    threadId: ThreadId;
    documentIds: readonly DocumentId[];
    actorTurnIds: readonly TurnId[];
    preexistingDraftIds: readonly string[];
  }): Promise<void>;
  createActiveDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    lastActorTurnId?: TurnId;
    baseLiveUpdateSeq?: number;
  }): Promise<Draft>;
  appendUpdate(input: {
    draftId: string;
    updateData: Uint8Array;
    actorTurnId?: TurnId;
    actorUserId?: UserId;
  }): Promise<void>;
  listUpdates(draftId: string): Promise<DraftUpdate[]>;
  markDraftCreatedDocument(input: { documentId: DocumentId; threadId: ThreadId }): Promise<void>;
  claimMutation(input: DraftClaimMutationInput): Promise<DraftClaimMutationResult>;
  finishClaimedMutation(input: DraftFinishClaimedMutationInput): Promise<Draft | null>;
  abortClaimedMutation(input: DraftAbortClaimedMutationInput): Promise<Draft | null>;
  reject(input: DraftLifecycleInput & { lease?: DraftClaimedMutationLease }): Promise<Draft | null>;
  reactivate(input: DraftLifecycleInput & { fromStatus: "discarded" }): Promise<Draft | null>;
  recoverAccepted(input: DraftLifecycleInput): Promise<void>;
  deleteCreatedDraftDocument(input: DraftLifecycleInput): Promise<void>;
};

export type DraftBasisUpdate = {
  updateData: Uint8Array;
  actorUserId?: UserId | null;
  actorTurnId?: TurnId | null;
};

export type DraftLifecycleInput = {
  documentId: DocumentId;
  threadId: ThreadId;
  draftId: string;
};

export type DraftMutationKind = "accept" | "reactivation";

export type DraftClaimedMutationLease = {
  readonly kind: DraftMutationKind;
  readonly documentId: DocumentId;
  readonly workId: WorkId;
  readonly draftId: string;
  readonly id: string;
  readonly restoreStatus: DraftStatus;
};

export type DraftClaimMutationInput = DraftLifecycleInput & {
  kind: DraftMutationKind;
  fromStatuses: readonly DraftStatus[];
};

export type DraftClaimMutationResult =
  | { status: "claimed"; draft: Draft; lease: DraftClaimedMutationLease }
  | { status: "in_progress"; draft: Draft }
  | { status: "conflict" }
  | { status: "not_found" };

export type DraftFinishClaimedMutationInput = {
  lease: DraftClaimedMutationLease;
  targetStatus: "active" | "applied" | "discarded";
  appliedByUserId?: UserId;
  appliedUpdateSeq?: number;
  baseLiveUpdateSeq?: number;
  updates?: readonly DraftBasisUpdate[];
};

export type DraftAbortClaimedMutationInput = {
  lease: DraftClaimedMutationLease;
  restoreStatus?: "active" | "applied";
};

export type AppliedDraft = Draft & { appliedUpdateSeq: number };

export type AcceptedDraftAppend = {
  appliedUpdateSeq: number;
  threadId: ThreadId;
  writeId?: string;
};

export type DraftAcceptMutation = AcceptedDraftAppend & {
  status: "active" | "reversed";
};

export type DraftLifecycleJournal = {
  findAcceptedDraftAppend(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    writeId: string;
  }): Promise<AcceptedDraftAppend | null>;
  findDraftAcceptMutation(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    writeId: string;
  }): Promise<DraftAcceptMutation | null>;
  listAcceptedDraftAppendsByWriteIdPrefix(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    writeIdPrefix: string;
  }): Promise<AcceptedDraftAppend[]>;
  appendAcceptedDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    update: Uint8Array;
    writeId: string;
    actorUserId: UserId;
    expectedDraftStatus: "active" | "accepting";
  }): Promise<AcceptedDraftAppend>;
};

export type DraftAcceptJournal = DraftLifecycleJournal;

export type DraftAcceptResult =
  | { status: "not_found" }
  | { status: "in_progress"; draftId: string }
  | { status: "discarded"; draftId: string }
  | { status: "invalid_created_document"; draftId: string }
  | { status: "stale_draft"; draftId: string; draftRevisionToken: number }
  | { status: "causal_dependency"; draftId: string; message: string }
  | {
      status: "closure_confirmation_required";
      draftId: string;
      requestedOperationIds: string[];
      closureOperationIds: string[];
      liveRevisionToken: number;
    }
  | {
      status: "overlap";
      draftId: string;
      liveRevisionToken: number;
      live: string;
      preview: string;
      overlappingBlocks: string[];
    }
  | { status: "applied"; draftId: string; appliedUpdateSeq: number }
  | {
      status: "partial_applied";
      draftId: string;
      appliedUpdateSeq: number;
      acceptedOperationIds: string[];
      writeId: string;
    };

export type DraftRejectResult = { status: "not_found" } | { status: "discarded"; draftId: string };

export type DraftUndoDomainResult =
  | { status: "reactivated"; draftId: string }
  | { status: "expired"; draftId: string }
  | {
      status: "conflict";
      draftId: string;
      reason?: "active_draft" | "reversal_failed" | "reactivation_in_progress" | "rebase_failed";
    }
  | { status: "not_found" };

export type { DraftService } from "./draft-review-service.js";
export { createDraftService } from "./draft-review-service.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeUlidTime(now: number): string {
  let value = Math.max(0, Math.floor(now));
  let output = "";
  for (let i = 0; i < 10; i += 1) {
    output = ULID_ALPHABET[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeUlidRandom(): string {
  const bytes = randomBytes(16);
  let output = "";
  for (let i = 0; i < 16; i += 1) output += ULID_ALPHABET[bytes[i] & 31];
  return output;
}
