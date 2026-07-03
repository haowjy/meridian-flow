/** Coherent draft review service: preview, journal, accept/reject, and undo orchestration. */
import { createHash } from "node:crypto";
import type {
  AgentEditCodec,
  AgentEditModel,
  DocumentCoordinator,
  UpdateJournal,
} from "@meridian/agent-edit";
import { DRAFT_UNDO_RETENTION_MS } from "@meridian/contracts/drafts";
import type { DocumentId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { acceptClosure } from "./draft-accept-closure.js";
import {
  buildDraftJournalSnapshot,
  buildLiveDocAtSeq,
  buildReviewDraftProjection,
  computeOverlapBlocks,
  serializePreview,
} from "./draft-projection.js";
import { rebaseReactivatedDraft } from "./draft-reactivation-rebase.js";
import { buildDraftReviewSnapshot } from "./draft-review-snapshot.js";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";
import type {
  ActiveDraft,
  Draft,
  DraftAcceptJournal,
  DraftAcceptMutation,
  DraftAcceptResult,
  DraftClaimedMutationLease,
  DraftLifecycleEvent,
  DraftRejectResult,
  DraftStore,
  DraftTurnContext,
  DraftUndoDomainResult,
  DraftUpdate,
  ReviewableDraft,
} from "./drafts.js";

type InvalidateInFlightDrafts = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

type RefreshAcceptedDraftProjection = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

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

export type DraftJournalSnapshot = {
  status: "active";
  draftRevisionToken: number;
  checkpoint: Uint8Array | null;
  updates: { seq: number; update: Uint8Array }[];
};

export type DraftReviewPreview = {
  live: string;
  markdown: string;
  liveRevisionToken: number;
  draftRevisionToken: number;
  inlineModelPresent: boolean;
  operationIds?: string[];
  operations?: DraftReviewOperationInternal[];
  hunks?: DraftReviewHunkInternal[];
};

export type DraftService = {
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
  getDraftJournal(input: {
    documentId: DocumentId;
    draftId: string;
  }): Promise<DraftJournalSnapshot | { status: "not_found" }>;
  previewDraft(input: { documentId: DocumentId; draftId: string }): Promise<DraftReviewPreview>;
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
  countInFlightDraftSessionsByWork(input: { workId: WorkId }): number;
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
    countInFlightDraftSessionsByWork: deps.countInFlightDraftSessionsByWork,
    getDraftJournal,
    previewDraft,
    acceptDraft,
    rejectDraft,
    undoAcceptDraft,
    undoRejectDraft,
  };

  async function getDraftJournal(input: { documentId: DocumentId; draftId: string }) {
    const result = await buildDraftJournalSnapshot(
      deps.liveUpdateJournal,
      deps.draftStore,
      input.documentId,
      input.draftId,
    );
    if (result.status === "not_found") return result;
    return {
      status: "active" as const,
      draftRevisionToken: result.revisionToken,
      checkpoint: result.snapshot.checkpoint,
      updates: result.snapshot.updates.map((update) => ({
        seq: update.seq,
        update: update.update,
      })),
    };
  }

  async function previewDraft(input: { documentId: DocumentId; draftId: string }) {
    const draftUpdates = await deps.draftStore.listUpdates(input.draftId);
    const snapshot = await buildCurrentReviewSnapshot(
      input.documentId,
      input.draftId,
      draftUpdates,
    );
    try {
      return {
        live: snapshot.live,
        markdown: snapshot.markdown,
        liveRevisionToken: snapshot.liveRevisionToken,
        draftRevisionToken: snapshot.draftRevisionToken,
        inlineModelPresent: snapshot.inlineModelPresent,
        ...(snapshot.operations && snapshot.hunks
          ? {
              operations: snapshot.operations,
              hunks: snapshot.hunks,
            }
          : {}),
      };
    } finally {
      snapshot.dispose();
    }
  }

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
          expectedDraftStatus: "accepting",
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
        expectedDraftStatus: "active",
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
    const snapshot = await buildCurrentReviewSnapshot(documentId, draftId, updates);
    try {
      return snapshot.operations && snapshot.hunks
        ? {
            operations: snapshot.operations,
            hunks: snapshot.hunks,
            liveRevisionToken: snapshot.liveRevisionToken,
          }
        : null;
    } finally {
      snapshot.dispose();
    }
  }

  async function buildCurrentReviewSnapshot(
    documentId: DocumentId,
    draftId: string,
    updates: readonly DraftUpdate[],
  ) {
    return buildDraftReviewSnapshot({
      journal: deps.liveUpdateJournal,
      draftStore: deps.draftStore,
      documentId,
      draftId,
      liveRevisionToken: await deps.latestLiveUpdateSeq(documentId),
      draftUpdates: updates,
      codec: deps.codec,
      model: deps.model,
    });
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

    let originalDraftDoc: Y.Doc | null = null;
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
      if (claim.status !== "claimed") {
        return { status: "conflict", draftId: input.draftId, reason: "reactivation_in_progress" };
      }
      const { draft: reactivated, lease } = claim;
      originalDraftDoc = await buildReviewProjectionAtLiveSeq(
        input.documentId,
        input.draft.id,
        input.draft.baseLiveUpdateSeq,
      );
      const originalUpdates = await deps.draftStore.listUpdates(input.draft.id);

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
            return { status: "conflict", draftId: input.draftId, reason: "reversal_failed" };
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
          originalUpdates,
          reversedWriteIds: new Set(input.writeIds.map((target) => target.writeId)),
          deps: {
            liveUpdateJournal: deps.liveUpdateJournal,
            liveJournal: deps.liveJournal,
            draftStore: deps.draftStore,
            latestLiveUpdateSeq: deps.latestLiveUpdateSeq,
            codec: deps.codec,
            model: deps.model,
          },
        });
      } catch {
        await deps.draftStore.abortClaimedMutation({ lease, restoreStatus: input.restoreStatus });
        return { status: "conflict", draftId: input.draftId, reason: "rebase_failed" };
      }
      await deps.refreshAcceptedProjection?.({
        documentId: input.documentId,
        threadId: input.threadId,
      });
      closeDraftRoom(input.draft.id);
      await invalidateInFlight(input);
      return { status: "reactivated", draftId: input.draftId };
    } finally {
      originalDraftDoc?.destroy();
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
    if (!reactivated) return { status: "conflict", draftId: input.draftId, reason: "active_draft" };

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

function isUniqueConstraintViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}
