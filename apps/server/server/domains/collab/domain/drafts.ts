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
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { DRAFT_UNDO_RETENTION_MS, type WIdRange } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { acceptClosure } from "./draft-accept-closure.js";
import {
  buildAtLiveSeq,
  buildLiveDocAtSeq,
  computeOverlapBlocks,
  buildDraftDoc as projectDraftDoc,
  serializePreview,
} from "./draft-projection.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";

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
  beginAccept(input: DraftLifecycleInput): Promise<DraftBeginAcceptResult>;
  releaseAccept(lease: DraftAcceptLease): Promise<boolean>;
  completeAccept(input: {
    lease: DraftAcceptLease;
    appliedByUserId: UserId;
    appliedUpdateSeq: number;
  }): Promise<boolean>;
  reject(input: DraftLifecycleInput & { acceptLease?: DraftAcceptLease }): Promise<Draft | null>;
  reactivate(
    input: DraftLifecycleInput & { fromStatus: "active" | "applied" | "discarded" },
  ): Promise<Draft | null>;
  cancelReactivation(
    input: DraftLifecycleInput & { restoreStatus?: "active" | "applied" },
  ): Promise<Draft | null>;
  replaceDraftBasis(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    baseLiveUpdateSeq: number;
    updates: readonly DraftBasisUpdate[];
  }): Promise<Draft | null>;
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

export type DraftAcceptLease = {
  readonly documentId: DocumentId;
  readonly workId: WorkId;
  readonly draftId: string;
  readonly id: string;
};

export type AppliedDraft = Draft & { appliedUpdateSeq: number };

export type DraftBeginAcceptResult =
  | { status: "claimed"; draft: Draft; lease: DraftAcceptLease }
  | { status: "in_progress"; draft: Draft }
  | { status: "already_applied"; draft: AppliedDraft }
  | { status: "not_found" };

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

type DraftProjectionCoordinator = {
  buildDraftDoc(input: { documentId: DocumentId; draftId: string }): Promise<Y.Doc>;
};

type DraftService = DraftProjectionCoordinator & {
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  getActiveDraftByWork(input: { documentId: DocumentId; workId: WorkId }): Promise<Draft | null>;
  resolveDraftThreadId(draftId: string): Promise<ThreadId | null>;
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
    confirmedClosure?: boolean;
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

function createDraftProjectionCoordinator(deps: {
  liveCoordinator: DocumentCoordinator;
  draftStore: Pick<DraftStore, "listUpdates">;
}): DraftProjectionCoordinator {
  const mutex = new KeyedMutex();

  return {
    buildDraftDoc({ documentId, draftId }) {
      return mutex.run(`${documentId}:${draftId}`, async () => {
        let liveState: Uint8Array | null = null;
        await deps.liveCoordinator.withDocument(documentId, async (liveDoc) => {
          liveState = Y.encodeStateAsUpdate(liveDoc);
        });
        const updates = await deps.draftStore.listUpdates(draftId);
        return projectDraftDoc(
          {
            checkpoint: liveState,
            updates: [],
          },
          updates,
        );
      });
    },
  };
}

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
  const projection = createDraftProjectionCoordinator({
    liveCoordinator: deps.liveCoordinator,
    draftStore: deps.draftStore,
  });

  return {
    getActiveDraft: deps.draftStore.getActiveDraft,
    getActiveDraftByWork: deps.draftStore.getActiveDraftByWork,
    resolveDraftThreadId: deps.draftStore.resolveDraftThreadId,
    draftTurnContext: deps.draftStore.draftTurnContext,
    listActiveDrafts: deps.draftStore.listActiveDrafts,
    listReviewableDrafts: deps.draftStore.listReviewableDrafts,
    listReviewableDraftsByWork: deps.draftStore.listReviewableDraftsByWork,
    listActiveDraftsByWork: deps.draftStore.listActiveDraftsByWork,
    listLifecycleEventsByWorkSince: deps.draftStore.listLifecycleEventsByWorkSince,
    countInFlightDraftSessionsByWork: () => 0,
    buildDraftDoc: projection.buildDraftDoc,
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
    confirmedClosure?: boolean;
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

    const accept = await deps.draftStore.beginAccept(input);
    if (accept.status === "in_progress") return { status: "in_progress", draftId: accept.draft.id };
    if (accept.status === "already_applied") {
      await recoverAppliedDraftSideEffects(input, accept.draft);
      return {
        status: "applied",
        draftId: accept.draft.id,
        appliedUpdateSeq: accept.draft.appliedUpdateSeq,
      };
    }
    if (accept.status === "not_found") {
      return { status: "not_found" };
    }

    const { draft, lease } = accept;
    closeDraftRoom(draft.id);
    await drainDraftRoomPersistence(draft.id);
    await invalidateInFlight(input);

    const updates = await deps.draftStore.listUpdates(draft.id);
    const draftRevisionToken = latestDraftRevisionToken(updates);
    if ((input.draftRevisionToken ?? draftRevisionToken) !== draftRevisionToken) {
      await deps.draftStore.releaseAccept(lease);
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }
    if (updates.length === 0) {
      const discarded = await deps.draftStore.reject({ ...input, acceptLease: lease });
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

    const applied = await deps.draftStore.completeAccept({
      lease,
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
      confirmedClosure?: boolean;
    },
    draft: Draft,
  ): Promise<DraftAcceptResult> {
    const updates = await deps.draftStore.listUpdates(draft.id);
    const draftRevisionToken = latestDraftRevisionToken(updates);
    if ((input.draftRevisionToken ?? draftRevisionToken) !== draftRevisionToken) {
      return { status: "stale_draft", draftId: draft.id, draftRevisionToken };
    }

    const review = await currentReviewModel(input.documentId, updates);
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
    if (closureExceedsRequest && !input.confirmedClosure) {
      return {
        status: "closure_confirmation_required",
        draftId: draft.id,
        requestedOperationIds: requestedSorted,
        closureOperationIds: closureSorted,
      };
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
      const applied = await applyUpdateWithEffectGuard(input.documentId, mergedUpdate);
      if (!applied) {
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

  async function applyUpdateWithEffectGuard(
    documentId: DocumentId,
    update: Uint8Array,
  ): Promise<boolean> {
    return deps.liveCoordinator.withDocument(documentId, async (doc) => {
      const before = Y.encodeStateVector(doc);
      Y.applyUpdate(doc, update, { type: "system" });
      return !equalBytes(before, Y.encodeStateVector(doc));
    });
  }

  async function fullyPartiallyAcceptedCompletion(
    input: { documentId: DocumentId; threadId: ThreadId; userId: UserId },
    draft: Draft,
    lease: DraftAcceptLease,
    updates: readonly DraftUpdate[],
  ): Promise<Extract<DraftAcceptResult, { status: "applied" }> | null> {
    const review = await currentReviewModel(input.documentId, updates);
    if (!review || (review.operations?.length ?? 1) > 0) return null;
    const partialAppends = await deps.liveJournal.listAcceptedDraftAppendsByWriteIdPrefix({
      documentId: input.documentId,
      threadId: input.threadId,
      writeIdPrefix: acceptGenerationWriteIdPrefix(draft),
    });
    if (partialAppends.length === 0) return null;
    const appliedUpdateSeq = Math.max(...partialAppends.map((append) => append.appliedUpdateSeq));
    const applied = await deps.draftStore.completeAccept({
      lease,
      appliedByUserId: input.userId,
      appliedUpdateSeq,
    });
    if (!applied) return null;
    await recoverAppliedDraftSideEffects(input, { ...draft, appliedUpdateSeq });
    return { status: "applied", draftId: draft.id, appliedUpdateSeq };
  }

  async function currentReviewModel(
    documentId: DocumentId,
    updates: readonly DraftUpdate[],
  ): Promise<{ operations?: ReviewOperation[]; hunks?: { operationIds: string[] }[] } | null> {
    const liveRevisionToken = await deps.latestLiveUpdateSeq(documentId);
    const liveDoc = await buildLiveDocThroughSeq(documentId, liveRevisionToken);
    const draftDoc = projectDraftDoc(
      { checkpoint: Y.encodeStateAsUpdate(liveDoc), updates: [] },
      updates,
    );
    try {
      const review = computeDraftReviewHunks({
        liveDoc,
        draftDoc,
        model: deps.model,
        draftUpdates: updates,
        requestedSurface: "inline",
      });
      return "operations" in review && "hunks" in review ? review : null;
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
    const previewDoc = await buildDraftDocAtLiveSeq(documentId, draft.id, liveRevisionToken);
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
    const previewDoc = await buildDraftDocAtLiveSeq(documentId, draft.id, liveRevisionToken);
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

  function buildDraftDocAtLiveSeq(
    documentId: DocumentId,
    draftId: string,
    liveRevisionToken: number,
  ): Promise<Y.Doc> {
    return buildAtLiveSeq(
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
    if (input.writeId) return undoPartialAcceptDraft(input, draft);
    if (
      !draft ||
      draft.documentId !== input.documentId ||
      draft.workId !== (await requireWorkId(input.threadId)) ||
      (draft.status !== "applied" && draft.status !== "reactivating")
    ) {
      return { status: "not_found" };
    }
    if (draft.appliedAt && Date.now() - draft.appliedAt.getTime() > DRAFT_UNDO_RETENTION_MS) {
      return { status: "expired", draftId: input.draftId };
    }

    closeDraftRoom(draft.id);
    await drainDraftRoomPersistence(draft.id);

    const originalDraftDoc = await buildDraftDocAtLiveSeq(
      input.documentId,
      draft.id,
      draft.baseLiveUpdateSeq,
    );
    try {
      // Claim a non-appendable reactivation slot before touching live state. The
      // unique partial index covers active/accepting/reactivating drafts, while
      // appenders and Hocuspocus room resolution accept only active drafts.
      const reactivated =
        draft.status === "reactivating"
          ? draft
          : await deps.draftStore.reactivate({
              documentId: input.documentId,
              threadId: input.threadId,
              draftId: input.draftId,
              fromStatus: "applied",
            });
      if (!reactivated) return { status: "conflict", draftId: input.draftId };

      // Reverse every active accept mutation in the generation before rebasing.
      // Partial accepts from the same generation must be removed from live first,
      // otherwise their content becomes part of the new base and disappears from
      // the reactivated review after the later partial reversal.
      if (deps.reverseAcceptedDraft) {
        const writeIds = await activeAcceptWriteIdsForGeneration(input, draft);
        let reversedCount = 0;
        for (const writeId of writeIds) {
          const reversed = await deps.reverseAcceptedDraft({
            documentId: input.documentId,
            threadId: input.threadId,
            writeId,
            userId: input.userId,
          });
          if (reversed !== "reversed") {
            if (reversedCount === 0) await deps.draftStore.cancelReactivation(input);
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
          originalDraftDoc,
          originalUpdates: await deps.draftStore.listUpdates(draft.id),
        });
      } catch {
        await deps.draftStore.cancelReactivation(input);
        return { status: "conflict", draftId: input.draftId };
      }
      closeDraftRoom(draft.id);
      await invalidateInFlight(input);
      return { status: "reactivated", draftId: input.draftId };
    } finally {
      originalDraftDoc.destroy();
    }
  }

  async function undoPartialAcceptDraft(
    input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: string;
      userId: UserId;
      writeId?: string;
    },
    draft: Draft | null,
  ): Promise<DraftUndoDomainResult> {
    if (
      !draft ||
      draft.documentId !== input.documentId ||
      draft.workId !== (await requireWorkId(input.threadId)) ||
      (draft.status !== "active" && draft.status !== "reactivating") ||
      !input.writeId ||
      !input.writeId.startsWith(acceptGenerationWriteIdPrefix(draft))
    ) {
      return { status: "not_found" };
    }
    const append = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId: input.writeId,
    });
    const existingMutation = append
      ? null
      : await deps.liveJournal.findDraftAcceptMutation({
          documentId: input.documentId,
          threadId: input.threadId,
          writeId: input.writeId,
        });
    const reversalAlreadyDone =
      draft.status === "reactivating" && existingMutation?.status === "reversed";
    if (!append && !reversalAlreadyDone) return { status: "not_found" };

    closeDraftRoom(draft.id);
    await drainDraftRoomPersistence(draft.id);

    const originalDraftDoc = await buildDraftDocAtLiveSeq(
      input.documentId,
      draft.id,
      draft.baseLiveUpdateSeq,
    );
    try {
      const reactivated =
        draft.status === "reactivating"
          ? draft
          : await deps.draftStore.reactivate({
              documentId: input.documentId,
              threadId: input.threadId,
              draftId: input.draftId,
              fromStatus: "active",
            });
      if (!reactivated) return { status: "conflict", draftId: input.draftId };

      if (deps.reverseAcceptedDraft && !reversalAlreadyDone) {
        const reversed = await deps.reverseAcceptedDraft({
          documentId: input.documentId,
          threadId: input.threadId,
          writeId: input.writeId,
          userId: input.userId,
        });
        if (reversed !== "reversed") {
          await deps.draftStore.cancelReactivation({ ...input, restoreStatus: "active" });
          return { status: "conflict", draftId: input.draftId };
        }
      }

      try {
        await rebaseReactivatedDraft({
          documentId: input.documentId,
          threadId: input.threadId,
          draft: reactivated,
          originalDraftDoc,
          originalUpdates: await deps.draftStore.listUpdates(draft.id),
        });
      } catch {
        await deps.draftStore.cancelReactivation({ ...input, restoreStatus: "active" });
        return { status: "conflict", draftId: input.draftId };
      }
      closeDraftRoom(draft.id);
      await invalidateInFlight(input);
      return { status: "reactivated", draftId: input.draftId };
    } finally {
      originalDraftDoc.destroy();
    }
  }

  async function activeAcceptWriteIdsForGeneration(
    input: { documentId: DocumentId; threadId: ThreadId },
    draft: Draft,
  ): Promise<string[]> {
    const fullWriteId = acceptWriteId(draft);
    const partials = await deps.liveJournal.listAcceptedDraftAppendsByWriteIdPrefix({
      documentId: input.documentId,
      threadId: input.threadId,
      writeIdPrefix: acceptGenerationWriteIdPrefix(draft),
    });
    const writeIds = new Set<string>(partials.flatMap((append) => append.writeId ?? []));
    const full = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId: fullWriteId,
    });
    if (full) writeIds.add(fullWriteId);
    return [...writeIds].sort((left, right) =>
      left === fullWriteId ? -1 : right === fullWriteId ? 1 : left.localeCompare(right),
    );
  }

  async function rebaseReactivatedDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draft: Draft;
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
    const rebasedDraft = await deps.draftStore.replaceDraftBasis({
      documentId: input.documentId,
      threadId: input.threadId,
      draftId: input.draft.id,
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
