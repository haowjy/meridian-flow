/** Draft review persistence, projection, and lifecycle services for collab documents. */
import { createHash, randomBytes } from "node:crypto";
import {
  type AgentEditCodec,
  type AgentEditModel,
  type DocumentCoordinator,
  fragmentOf,
  toDocHandle,
  type UpdateJournal,
} from "@meridian/agent-edit";
import { DRAFT_UNDO_RETENTION_MS, type WIdRange } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { acceptClosure } from "./draft-accept-closure.js";
import {
  buildLiveDocAtSeq,
  buildReviewBasisDocs,
  buildReviewDraftProjection,
  computeOverlapBlocks,
  serializePreview,
} from "./draft-projection.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { DraftReviewOperationInternal } from "./draft-review-operations.js";

export { acceptClosure } from "./draft-accept-closure.js";

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

function acceptWriteId(draft: Pick<Draft, "id" | "acceptGeneration">): string {
  return `draft-accept:${draft.id}:${draft.acceptGeneration}`;
}

function partialAcceptWriteId(
  draft: Pick<Draft, "id" | "acceptGeneration">,
  operationIds: readonly string[],
): string {
  const hash = createHash("sha256")
    .update([...operationIds].sort().join("\0"))
    .digest("hex")
    .slice(0, 12);
  return `${acceptWriteId(draft)}:op:${hash}`;
}

function acceptGenerationWriteIdPrefix(draft: Pick<Draft, "id" | "acceptGeneration">): string {
  return `${acceptWriteId(draft)}:op:`;
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
  }): Promise<AcceptedDraftAppend>;
};

export type DraftAcceptJournal = DraftLifecycleJournal;

type InvalidateInFlightDrafts = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

type RefreshAcceptedDraftProjection = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

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
  | { status: "conflict"; draftId: string }
  | { status: "not_found" };

type DraftService = {
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  getActiveDraftByWork(input: { documentId: DocumentId; workId: WorkId }): Promise<Draft | null>;
  getDraft(draftId: string): Promise<Draft | null>;
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
  countInFlightDraftSessionsByWork(input: { workId: WorkId }): number;
  acceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
    draftRevisionToken?: number;
    operationIds?: string[];
    confirmedClosureOperationIds?: string[];
  }): Promise<DraftAcceptResult>;
  rejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftRejectResult>;
  undoAcceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    writeId?: string;
  }): Promise<DraftUndoDomainResult>;
  undoRejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftUndoDomainResult>;
};

export function createDraftService(deps: {
  draftStore: DraftStore;
  liveJournal: DraftAcceptJournal;
  liveUpdateJournal: Pick<UpdateJournal, "read">;
  latestLiveUpdateSeq(documentId: DocumentId): Promise<number>;
  liveCoordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
  invalidateInFlight?: InvalidateInFlightDrafts;
  drainDraftRoomPersistence?(draftId: string): Promise<void>;
  closeDraftRoom?(draftId: string): void;
  refreshAcceptedProjection?: RefreshAcceptedDraftProjection;
  reverseAcceptedDraft?(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    writeId: string;
    userId: UserId;
  }): Promise<"reversed" | "not_reversed">;
}): DraftService {
  const invalidateInFlight = deps.invalidateInFlight ?? (async () => {});
  const drainDraftRoomPersistence = deps.drainDraftRoomPersistence ?? (async () => {});
  const closeDraftRoom = deps.closeDraftRoom ?? (() => {});

  return {
    getActiveDraft: deps.draftStore.getActiveDraft,
    getActiveDraftByWork: deps.draftStore.getActiveDraftByWork,
    getDraft: deps.draftStore.getDraft,
    resolveDraftThreadId: deps.draftStore.resolveDraftThreadId,
    resolvePrimaryThreadForWork: deps.draftStore.resolvePrimaryThreadForWork,
    draftTurnContext: deps.draftStore.draftTurnContext,
    listActiveDrafts: deps.draftStore.listActiveDrafts,
    listReviewableDrafts: deps.draftStore.listReviewableDrafts,
    listReviewableDraftsByWork: deps.draftStore.listReviewableDraftsByWork,
    listActiveDraftsByWork: deps.draftStore.listActiveDraftsByWork,
    listLifecycleEventsByWorkSince: deps.draftStore.listLifecycleEventsByWorkSince,
    countInFlightDraftSessionsByWork: () => 0,
    acceptDraft,
    rejectDraft,
    undoAcceptDraft,
    undoRejectDraft,
  };

  async function requireWorkId(threadId: ThreadId): Promise<WorkId> {
    const workId = await deps.draftStore.resolveWorkId(threadId);
    if (!workId) throw new Error(`Thread ${threadId} has no primary work`);
    return workId;
  }

  async function acceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
    draftRevisionToken?: number;
    operationIds?: string[];
    confirmedClosureOperationIds?: string[];
  }): Promise<DraftAcceptResult> {
    await drainDraftRoomPersistence(input.draftId);

    const requestedDraft = await deps.draftStore.getDraft(input.draftId);
    if (
      requestedDraft?.createdDocument === false &&
      !(await liveDocumentExists(input.documentId))
    ) {
      return { status: "invalid_created_document", draftId: requestedDraft.id };
    }
    if (
      requestedDraft?.documentId === input.documentId &&
      requestedDraft.workId === (await requireWorkId(input.threadId)) &&
      requestedDraft.status === "active"
    ) {
      const updates = await deps.draftStore.listUpdates(requestedDraft.id);
      const hasDraftContent = updates.length > 0;
      if (hasDraftContent && !input.confirmOverlap) {
        const overlappingBlocks = await detectAcceptOverlap(input.documentId, requestedDraft);
        if (overlappingBlocks) {
          return overlapReview(input.documentId, requestedDraft, overlappingBlocks);
        }
      }
      if (
        hasDraftContent &&
        input.confirmOverlap &&
        (input.confirmedLiveRevisionToken === undefined ||
          (await overlapChangedSinceConfirmation({
            documentId: input.documentId,
            draft: requestedDraft,
            confirmedLiveRevisionToken: input.confirmedLiveRevisionToken,
          })))
      ) {
        const overlappingBlocks = await detectAcceptOverlap(input.documentId, requestedDraft);
        return overlapReview(input.documentId, requestedDraft, overlappingBlocks ?? []);
      }
      if (input.operationIds && input.operationIds.length > 0) {
        return acceptDraftOperations(input, requestedDraft);
      }
    }

    if (
      requestedDraft?.documentId === input.documentId &&
      requestedDraft.workId === (await requireWorkId(input.threadId)) &&
      requestedDraft.status === "applied" &&
      requestedDraft.appliedUpdateSeq !== null
    ) {
      await recoverAppliedDraftSideEffects(input, {
        ...requestedDraft,
        appliedUpdateSeq: requestedDraft.appliedUpdateSeq,
      });
      return {
        status: "applied",
        draftId: requestedDraft.id,
        appliedUpdateSeq: requestedDraft.appliedUpdateSeq,
      };
    }

    const accept = await deps.draftStore.claimMutation({
      ...input,
      kind: "accept",
      fromStatuses: ["active"],
    });
    if (accept.status === "in_progress") return { status: "in_progress", draftId: accept.draft.id };
    if (accept.status === "not_found" || accept.status === "conflict") {
      return { status: "not_found" };
    }

    const { draft, lease } = accept;
    closeDraftRoom(draft.id);
    await drainDraftRoomPersistence(draft.id);
    await invalidateInFlight(input);

    const updates = await deps.draftStore.listUpdates(draft.id);
    const draftRevisionToken = latestDraftRevisionToken(updates);
    if ((input.draftRevisionToken ?? draftRevisionToken) !== draftRevisionToken) {
      await deps.draftStore.abortClaimedMutation({ lease });
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }
    if (updates.length === 0) {
      const discarded = await deps.draftStore.reject({ ...input, lease });
      if (!discarded) return { status: "not_found" };
      return { status: "discarded", draftId: draft.id };
    }

    const completion = await fullyPartiallyAcceptedCompletion(input, draft, lease, updates);
    if (completion) return completion;

    // Writer-only drafts can have no producing assistant turn. Accept still
    // materializes the content; we skip transcript insertion below because
    // there is no model turn to annotate as provenance.

    const mergedUpdate = Y.mergeUpdates(updates.map((update) => update.updateData));
    const writeId = acceptWriteId(draft);
    let acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });

    if (acceptedAppend === null) {
      try {
        acceptedAppend = await deps.liveJournal.appendAcceptedDraft({
          documentId: input.documentId,
          threadId: input.threadId,
          draftId: draft.id,
          update: mergedUpdate,
          writeId,
          actorUserId: input.userId,
        });
      } catch (cause) {
        if (!isUniqueConstraintViolation(cause)) throw cause;
        acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
          documentId: input.documentId,
          threadId: input.threadId,
          writeId,
        });
        if (acceptedAppend === null) throw cause;
      }
    }
    const { appliedUpdateSeq } = acceptedAppend;

    const applied = await deps.draftStore.finishClaimedMutation({
      lease,
      targetStatus: "applied",
      appliedByUserId: input.userId,
      appliedUpdateSeq,
    });
    if (!applied) return { status: "not_found" };

    await deps.liveCoordinator.withDocument(input.documentId, async (doc) => {
      Y.applyUpdate(doc, mergedUpdate, { type: "system" });
    });

    await recoverAppliedDraftSideEffects(input, { ...draft, appliedUpdateSeq });

    return {
      status: "applied",
      draftId: draft.id,
      appliedUpdateSeq,
    };
  }

  async function acceptDraftOperations(
    input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: string;
      userId: UserId;
      draftRevisionToken?: number;
      operationIds?: string[];
      confirmedClosureOperationIds?: string[];
      confirmedLiveRevisionToken?: number;
    },
    draft: Draft,
  ): Promise<DraftAcceptResult> {
    const updates = await deps.draftStore.listUpdates(draft.id);
    const draftRevisionToken = latestDraftRevisionToken(updates);
    if ((input.draftRevisionToken ?? draftRevisionToken) !== draftRevisionToken) {
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }

    const review = await currentReviewModel(input.documentId, draft.id, updates);
    if (!review?.operations || !review.hunks) {
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }
    const requested = new Set(input.operationIds ?? []);
    const operationById = new Map(
      review.operations.map((operation) => [operation.operationId, operation]),
    );
    if ([...requested].some((operationId) => !operationById.has(operationId))) {
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }

    const closure = acceptClosure({
      requestedOperationIds: [...requested],
      operations: review.operations,
      hunks: review.hunks,
      updates,
    });
    const acceptedOperationIds = closure.operationIds;
    const requestedSorted = [...requested].sort();
    const closureSorted = [...acceptedOperationIds].sort();
    const closureExceedsRequest =
      closureSorted.length !== requestedSorted.length ||
      closureSorted.some((operationId, index) => operationId !== requestedSorted[index]);
    if (closureExceedsRequest) {
      const confirmedClosureSorted = [...(input.confirmedClosureOperationIds ?? [])].sort();
      const closureConfirmed =
        input.confirmedLiveRevisionToken === review.liveRevisionToken &&
        confirmedClosureSorted.length === closureSorted.length &&
        closureSorted.every((operationId, index) => operationId === confirmedClosureSorted[index]);
      if (!closureConfirmed) {
        return {
          status: "closure_confirmation_required",
          draftId: draft.id,
          requestedOperationIds: requestedSorted,
          closureOperationIds: closureSorted,
          liveRevisionToken: review.liveRevisionToken,
        };
      }
    }
    const selectedUpdates = updates.filter((update) => closure.updateIds.has(update.id));
    if (selectedUpdates.length === 0) {
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }

    const mergedUpdate = Y.mergeUpdates(selectedUpdates.map((update) => update.updateData));
    const writeId = partialAcceptWriteId(draft, acceptedOperationIds);
    let acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });
    if (acceptedAppend === null) {
      const hasEffect = await updateHasLiveEffect(input.documentId, mergedUpdate);
      if (!hasEffect) {
        return {
          status: "causal_dependency",
          draftId: draft.id,
          message:
            "The selected draft operation depends on earlier draft edits. Accept the dragged operations, accept the earlier proposal first, or apply the whole draft.",
        };
      }
      acceptedAppend = await deps.liveJournal.appendAcceptedDraft({
        documentId: input.documentId,
        threadId: input.threadId,
        draftId: draft.id,
        update: mergedUpdate,
        writeId,
        actorUserId: input.userId,
      });
      await applyUpdateWithEffectGuard(input.documentId, mergedUpdate);
    } else {
      await applyUpdateWithEffectGuard(input.documentId, mergedUpdate);
    }
    await deps.refreshAcceptedProjection?.({
      documentId: input.documentId,
      threadId: input.threadId,
    });

    return {
      status: "partial_applied",
      draftId: draft.id,
      appliedUpdateSeq: acceptedAppend.appliedUpdateSeq,
      acceptedOperationIds,
      writeId,
    };
  }

  async function updateHasLiveEffect(documentId: DocumentId, update: Uint8Array): Promise<boolean> {
    return deps.liveCoordinator.withDocument(documentId, async (doc) => {
      const probe = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc), { type: "system" });
        return docContentChanged(probe, () => Y.applyUpdate(probe, update, { type: "system" }));
      } finally {
        probe.destroy();
      }
    });
  }

  async function applyUpdateWithEffectGuard(
    documentId: DocumentId,
    update: Uint8Array,
  ): Promise<boolean> {
    return deps.liveCoordinator.withDocument(documentId, async (doc) =>
      docContentChanged(doc, () => Y.applyUpdate(doc, update, { type: "system" })),
    );
  }

  async function fullyPartiallyAcceptedCompletion(
    input: { documentId: DocumentId; threadId: ThreadId; userId: UserId },
    draft: Draft,
    lease: DraftClaimedMutationLease,
    updates: readonly DraftUpdate[],
  ): Promise<Extract<DraftAcceptResult, { status: "applied" }> | null> {
    const review = await currentReviewModel(input.documentId, draft.id, updates);
    if (!review || (review.operations?.length ?? 1) > 0) return null;
    const partialAppends = await deps.liveJournal.listAcceptedDraftAppendsByWriteIdPrefix({
      documentId: input.documentId,
      threadId: input.threadId,
      writeIdPrefix: acceptGenerationWriteIdPrefix(draft),
    });
    if (partialAppends.length === 0) return null;
    const appliedUpdateSeq = Math.max(...partialAppends.map((append) => append.appliedUpdateSeq));
    const applied = await deps.draftStore.finishClaimedMutation({
      lease,
      targetStatus: "applied",
      appliedByUserId: input.userId,
      appliedUpdateSeq,
    });
    if (!applied) return null;
    await recoverAppliedDraftSideEffects(input, { ...draft, appliedUpdateSeq });
    return { status: "applied", draftId: draft.id, appliedUpdateSeq };
  }

  async function currentReviewModel(
    documentId: DocumentId,
    draftId: string,
    updates: readonly DraftUpdate[],
  ): Promise<{
    operations?: DraftReviewOperationInternal[];
    hunks?: { operationIds: string[] }[];
    liveRevisionToken: number;
  } | null> {
    const liveRevisionToken = await deps.latestLiveUpdateSeq(documentId);
    const { liveDoc, draftDoc } = await buildReviewBasisDocs(
      deps.liveUpdateJournal,
      deps.draftStore,
      documentId,
      draftId,
      liveRevisionToken,
    );
    try {
      const review = computeDraftReviewHunks({
        liveDoc,
        draftDoc,
        model: deps.model,
        draftUpdates: updates,
      });
      return "operations" in review ? { ...review, liveRevisionToken } : null;
    } finally {
      liveDoc.destroy();
      draftDoc.destroy();
    }
  }

  async function liveDocumentExists(documentId: DocumentId): Promise<boolean> {
    try {
      await deps.liveCoordinator.withDocument(documentId, async () => undefined);
      return true;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("document_not_found")) return false;
      throw cause;
    }
  }

  async function detectAcceptOverlap(
    documentId: DocumentId,
    draft: Draft,
    inputLiveRevisionToken?: number,
  ): Promise<string[] | null> {
    // Block overlap is an accept-time UX gate, not the data-integrity boundary:
    // if this conservative diff ever misses an overlap, Yjs still CRDT-merges
    // non-destructively and the P5 accept event remains independently undoable.
    // Compacted history can only make this gate less precise; it must not grow
    // a second apply path or replace the independent undo safety net.
    const liveRevisionToken =
      inputLiveRevisionToken ?? (await deps.latestLiveUpdateSeq(documentId));
    const base = await buildLiveDocThroughSeq(documentId, draft.baseLiveUpdateSeq);
    const liveNow = await buildLiveDocThroughSeq(documentId, liveRevisionToken);
    const previewDoc = await buildReviewDraftProjection(
      deps.liveUpdateJournal,
      deps.draftStore,
      documentId,
      draft.id,
      liveRevisionToken,
    );
    try {
      const overlappingBlocks = computeOverlapBlocks({
        baseDoc: base,
        liveDoc: liveNow,
        draftDoc: previewDoc,
        model: deps.model,
        codec: deps.codec,
      });
      return overlappingBlocks.length > 0 ? overlappingBlocks : null;
    } finally {
      base.destroy();
      liveNow.destroy();
      previewDoc.destroy();
    }
  }

  async function overlapChangedSinceConfirmation(input: {
    documentId: DocumentId;
    draft: Draft;
    confirmedLiveRevisionToken: number;
  }): Promise<boolean> {
    const currentLiveRevisionToken = await deps.latestLiveUpdateSeq(input.documentId);
    if (currentLiveRevisionToken <= input.confirmedLiveRevisionToken) return false;
    const confirmed = await overlapBlockSet(
      input.documentId,
      input.draft,
      input.confirmedLiveRevisionToken,
    );
    const current = await overlapBlockSet(input.documentId, input.draft, currentLiveRevisionToken);
    return current.size > 0 || !sameStringSet(confirmed, current);
  }

  async function overlapBlockSet(
    documentId: DocumentId,
    draft: Draft,
    liveRevisionToken: number,
  ): Promise<Set<string>> {
    const overlap = await detectAcceptOverlap(documentId, draft, liveRevisionToken);
    return new Set(overlap ?? []);
  }

  async function overlapReview(
    documentId: DocumentId,
    draft: Draft,
    overlappingBlocks: string[],
  ): Promise<Extract<DraftAcceptResult, { status: "overlap" }>> {
    const liveRevisionToken = await deps.latestLiveUpdateSeq(documentId);
    const liveNow = await buildLiveDocThroughSeq(documentId, liveRevisionToken);
    const previewDoc = await buildReviewDraftProjection(
      deps.liveUpdateJournal,
      deps.draftStore,
      documentId,
      draft.id,
      liveRevisionToken,
    );
    try {
      return {
        status: "overlap",
        draftId: draft.id,
        liveRevisionToken,
        live: serializePreview(liveNow, deps.codec, deps.model),
        preview: serializePreview(previewDoc, deps.codec, deps.model),
        overlappingBlocks,
      };
    } finally {
      liveNow.destroy();
      previewDoc.destroy();
    }
  }

  function buildReviewProjectionAtLiveSeq(
    documentId: DocumentId,
    draftId: string,
    liveRevisionToken: number,
  ): Promise<Y.Doc> {
    return buildReviewDraftProjection(
      deps.liveUpdateJournal,
      deps.draftStore,
      documentId,
      draftId,
      liveRevisionToken,
    );
  }

  function buildLiveDocThroughSeq(documentId: DocumentId, seq: number): Promise<Y.Doc> {
    return buildLiveDocAtSeq(deps.liveUpdateJournal, documentId, seq);
  }

  async function rejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftRejectResult> {
    const draft = await deps.draftStore.reject(input);
    if (!draft) return { status: "not_found" };

    closeDraftRoom(draft.id);
    await drainDraftRoomPersistence(draft.id);
    await invalidateInFlight(input);

    if (draft.createdDocument) {
      await deps.draftStore.deleteCreatedDraftDocument(input);
    }

    return { status: "discarded", draftId: draft.id };
  }

  async function undoAcceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    writeId?: string;
  }): Promise<DraftUndoDomainResult> {
    const draft = await deps.draftStore.getDraft(input.draftId);
    if (
      !draft ||
      draft.documentId !== input.documentId ||
      draft.workId !== (await requireWorkId(input.threadId))
    ) {
      return { status: "not_found" };
    }

    if (input.writeId) {
      if (
        (draft.status !== "active" && draft.status !== "reactivating") ||
        !input.writeId.startsWith(acceptGenerationWriteIdPrefix(draft))
      ) {
        return { status: "not_found" };
      }
      const mutation = await acceptedDraftMutation(input, input.writeId);
      if (!mutation || (mutation.status === "reversed" && draft.status !== "reactivating")) {
        return { status: "not_found" };
      }
      return reactivateAfterReversing({
        ...input,
        draft,
        claimFromStatuses: ["active"],
        restoreStatus: "active",
        writeIds: [{ writeId: input.writeId, alreadyReversed: mutation.status === "reversed" }],
      });
    }

    if (draft.status !== "applied" && draft.status !== "reactivating") {
      return { status: "not_found" };
    }
    if (draft.appliedAt && Date.now() - draft.appliedAt.getTime() > DRAFT_UNDO_RETENTION_MS) {
      return { status: "expired", draftId: input.draftId };
    }

    return reactivateAfterReversing({
      ...input,
      draft,
      claimFromStatuses: ["applied"],
      restoreStatus: "applied",
      writeIds: await acceptWriteIdsForGeneration(input, draft),
    });
  }

  async function reactivateAfterReversing(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    draft: Draft;
    claimFromStatuses: readonly ("active" | "applied")[];
    restoreStatus: "active" | "applied";
    writeIds: readonly { writeId: string; alreadyReversed: boolean }[];
  }): Promise<DraftUndoDomainResult> {
    closeDraftRoom(input.draft.id);
    await drainDraftRoomPersistence(input.draft.id);

    const originalDraftDoc = await buildReviewProjectionAtLiveSeq(
      input.documentId,
      input.draft.id,
      input.draft.baseLiveUpdateSeq,
    );
    try {
      // Claim a non-appendable reactivation slot before touching live state. The
      // unique partial index covers active/accepting/reactivating drafts, while
      // appenders and Hocuspocus room resolution accept only active drafts.
      const claim = await deps.draftStore.claimMutation({
        documentId: input.documentId,
        threadId: input.threadId,
        draftId: input.draftId,
        kind: "reactivation",
        fromStatuses: input.claimFromStatuses,
      });
      if (claim.status === "not_found") return { status: "not_found" };
      if (claim.status !== "claimed") return { status: "conflict", draftId: input.draftId };
      const { draft: reactivated, lease } = claim;

      if (deps.reverseAcceptedDraft) {
        let reversedCount = 0;
        for (const target of input.writeIds) {
          if (target.alreadyReversed) {
            reversedCount += 1;
            continue;
          }
          const reversed = await deps.reverseAcceptedDraft({
            documentId: input.documentId,
            threadId: input.threadId,
            writeId: target.writeId,
            userId: input.userId,
          });
          if (reversed !== "reversed") {
            if (reversedCount === 0) {
              await deps.draftStore.abortClaimedMutation({
                lease,
                restoreStatus: input.restoreStatus,
              });
            }
            return { status: "conflict", draftId: input.draftId };
          }
          reversedCount += 1;
        }
      }

      try {
        await rebaseReactivatedDraft({
          documentId: input.documentId,
          threadId: input.threadId,
          draft: reactivated,
          lease,
          originalDraftDoc,
          originalUpdates: await deps.draftStore.listUpdates(input.draft.id),
        });
      } catch {
        await deps.draftStore.abortClaimedMutation({ lease, restoreStatus: input.restoreStatus });
        return { status: "conflict", draftId: input.draftId };
      }
      await deps.refreshAcceptedProjection?.({
        documentId: input.documentId,
        threadId: input.threadId,
      });
      closeDraftRoom(input.draft.id);
      await invalidateInFlight(input);
      return { status: "reactivated", draftId: input.draftId };
    } finally {
      originalDraftDoc.destroy();
    }
  }

  async function acceptedDraftMutation(
    input: { documentId: DocumentId; threadId: ThreadId },
    writeId: string,
  ): Promise<DraftAcceptMutation | null> {
    const append = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });
    if (append) return { ...append, status: "active" };
    return deps.liveJournal.findDraftAcceptMutation({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });
  }

  async function acceptWriteIdsForGeneration(
    input: { documentId: DocumentId; threadId: ThreadId },
    draft: Draft,
  ): Promise<{ writeId: string; alreadyReversed: boolean }[]> {
    const fullWriteId = acceptWriteId(draft);
    const partials = await deps.liveJournal.listAcceptedDraftAppendsByWriteIdPrefix({
      documentId: input.documentId,
      threadId: input.threadId,
      writeIdPrefix: acceptGenerationWriteIdPrefix(draft),
    });
    const writeIds = new Map<string, boolean>();
    for (const append of partials) {
      if (append.writeId) writeIds.set(append.writeId, false);
    }
    const full = await acceptedDraftMutation(input, fullWriteId);
    if (full) writeIds.set(fullWriteId, full.status === "reversed");
    return [...writeIds]
      .map(([writeId, alreadyReversed]) => ({ writeId, alreadyReversed }))
      .sort((left, right) =>
        left.writeId === fullWriteId
          ? -1
          : right.writeId === fullWriteId
            ? 1
            : left.writeId.localeCompare(right.writeId),
      );
  }

  async function rebaseReactivatedDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draft: Draft;
    lease: DraftClaimedMutationLease;
    originalDraftDoc: Y.Doc;
    originalUpdates: readonly DraftUpdate[];
  }): Promise<void> {
    const draftIntentMarkdown = serializePreview(input.originalDraftDoc, deps.codec, deps.model);
    const baseLiveUpdateSeq = await deps.latestLiveUpdateSeq(input.documentId);
    const oldDoc = await buildLiveDocThroughSeq(input.documentId, input.draft.baseLiveUpdateSeq);
    const liveDoc = await buildLiveDocThroughSeq(input.documentId, baseLiveUpdateSeq);
    const postUndoLiveMarkdown = serializePreview(liveDoc, deps.codec, deps.model);
    const newDoc = createCollabYDoc({ gc: false });
    const updates: DraftBasisUpdate[] = [];
    try {
      Y.applyUpdate(newDoc, Y.encodeStateAsUpdate(liveDoc));
      for (const row of input.originalUpdates) {
        const beforeRowMarkdown = serializePreview(oldDoc, deps.codec, deps.model);
        Y.applyUpdate(oldDoc, row.updateData, { type: "system" });
        const rowMarkdown = serializePreview(oldDoc, deps.codec, deps.model);
        const before = Y.encodeStateVector(newDoc);
        reapplyMarkdownDelta(newDoc, beforeRowMarkdown, rowMarkdown);
        const after = Y.encodeStateVector(newDoc);
        if (equalBytes(before, after)) continue;
        updates.push({
          updateData: Y.encodeStateAsUpdate(newDoc, before),
          actorUserId: row.actorUserId,
          actorTurnId: row.actorTurnId,
        });
      }
      const hadDraftIntentBeyondLive =
        normalizeSerializedMarkdown(draftIntentMarkdown) !==
        normalizeSerializedMarkdown(postUndoLiveMarkdown);
      if (hadDraftIntentBeyondLive && updates.length === 0) {
        throw new Error(
          `Segmented draft rebase produced an empty journal for ${input.draft.id} after reversal left live unchanged relative to draft intent`,
        );
      }
    } finally {
      oldDoc.destroy();
      liveDoc.destroy();
      newDoc.destroy();
    }
    const rebasedDraft = await deps.draftStore.finishClaimedMutation({
      lease: input.lease,
      targetStatus: "active",
      baseLiveUpdateSeq,
      updates,
    });
    if (!rebasedDraft) throw new Error(`Failed to rebase reactivated draft ${input.draft.id}`);
  }

  function reapplyMarkdownDelta(doc: Y.Doc, beforeMarkdown: string, afterMarkdown: string): void {
    const currentMarkdown = serializePreview(doc, deps.codec, deps.model);
    if (normalizeSerializedMarkdown(currentMarkdown) === normalizeSerializedMarkdown(afterMarkdown))
      return;
    if (normalizeSerializedMarkdown(beforeMarkdown) === normalizeSerializedMarkdown(afterMarkdown))
      return;
    if (normalizeSerializedMarkdown(beforeMarkdown).length === 0) {
      replaceDocMarkdown(doc, afterMarkdown);
      return;
    }
    if (afterMarkdown.startsWith(beforeMarkdown)) {
      const appended = afterMarkdown.slice(beforeMarkdown.length).trim();
      if (appended.length > 0) {
        doc.transact(
          () => {
            const blocks = deps.model.getBlocks(toDocHandle(doc));
            deps.model.insertBlocks(
              toDocHandle(doc),
              blocks.at(-1) ?? null,
              deps.codec.parse(appended),
            );
          },
          { type: "system" },
        );
        return;
      }
    }
    replaceDocMarkdown(doc, afterMarkdown);
  }

  function replaceDocMarkdown(doc: Y.Doc, markdown: string): void {
    const parsed = deps.codec.parse(markdown);
    doc.transact(
      () => {
        const fragment = fragmentOf(doc);
        if (fragment.length > 0) fragment.delete(0, fragment.length);
        deps.model.insertBlocks(toDocHandle(doc), null, parsed);
      },
      { type: "system" },
    );
  }

  async function undoRejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftUndoDomainResult> {
    const draft = await deps.draftStore.getDraft(input.draftId);
    if (
      !draft ||
      draft.documentId !== input.documentId ||
      draft.workId !== (await requireWorkId(input.threadId)) ||
      draft.status !== "discarded"
    ) {
      return { status: "not_found" };
    }
    if (draft.discardedAt && Date.now() - draft.discardedAt.getTime() > DRAFT_UNDO_RETENTION_MS) {
      return { status: "expired", draftId: input.draftId };
    }

    const reactivated = await deps.draftStore.reactivate({
      documentId: input.documentId,
      threadId: input.threadId,
      draftId: input.draftId,
      fromStatus: "discarded",
    });
    if (!reactivated) return { status: "conflict", draftId: input.draftId };

    await invalidateInFlight(input);
    return { status: "reactivated", draftId: input.draftId };
  }

  async function recoverAppliedDraftSideEffects(
    input: { documentId: DocumentId; threadId: ThreadId },
    draft: Pick<Draft, "id" | "appliedUpdateSeq">,
  ): Promise<void> {
    if (draft.appliedUpdateSeq === null) return;
    await deps.liveCoordinator.recover(input.documentId);
    await deps.refreshAcceptedProjection?.({
      documentId: input.documentId,
      threadId: input.threadId,
    });
    await deps.draftStore.recoverAccepted({ ...input, draftId: draft.id });
  }
}

function docContentChanged(doc: Y.Doc, mutate: () => void): boolean {
  const before = Y.encodeStateAsUpdate(doc);
  mutate();
  return !equalBytes(before, Y.encodeStateAsUpdate(doc));
}

function latestDraftRevisionToken(updates: readonly DraftUpdate[]): number {
  return updates.reduce((max, update) => Math.max(max, update.id), 0);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function normalizeSerializedMarkdown(markdown: string): string {
  return markdown.replace(/\u00a0/g, " ").trim();
}

function isUniqueConstraintViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

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
