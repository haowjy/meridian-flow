// Response committer: explicit response lifecycle states and staged-write buffering.
import * as Y from "yjs";
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, JournalCommitKind } from "../ports/update-journal.js";
import { mutationMode, responseInteractionContext } from "./interaction-mode.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { JournaledUpdate, MutationCommit } from "./mutation-commit.js";
import {
  bufferedLifecycle,
  closedLifecycle,
  hasCommittedJournalKind,
  journalCommittedLifecycle,
  journalKindFromLifecycle,
  lifecycleToCommitterPhase,
  liveProjectedLifecycle,
  type MutationLifecycle,
} from "./response-lifecycle.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  ResponseClaimDiscardedEntry,
  ResponseCommitDocumentResult,
  ResponseCommitResult,
  ResponseCommitterTransition,
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleClosedState,
  ResponseLifecycleErrorDetail,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  WriteCommand,
} from "./types.js";

export interface ResponseCommitter {
  assertCanStage(input: ResponseStagePreflightInput): void;
  stageUpdate(input: ResponseStageUpdateInput): void;
  commitResponse(responseId: string): Promise<ResponseCommitResult>;
  rollbackResponse(responseId: string): Promise<ResponseRollbackResult>;
  hasBufferedWrites(responseId: string): boolean;
  bufferedUpdatesForDoc(responseId: string, docId: string): readonly Uint8Array[];
  stagedCreatedDocumentIds(responseId: string, threadId?: string): readonly string[];
  dropForThread(docId: string, threadId: string): void;
}

export interface ResponseStagePreflightInput {
  responseId: string;
  docId?: string;
  session?: ActorSession;
  turnId?: string;
  writeId?: string;
}

export interface ResponseStageUpdateInput {
  responseId: string;
  docId: string;
  session: ActorSession;
  runtime: RuntimeDocumentState;
  commandName: WriteCommand["command"];
  update: Uint8Array;
  meta: UpdateMeta;
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  writeId?: string;
  writeOrdinal?: number;
  durableWriteId?: string;
  ensureDocumentBeforeCommit?: boolean;
  createdDocumentBeforeCommit: boolean;
  updateKind?: string;
  interactionContext?: InteractionContext;
}

interface StagedResponseUpdate extends JournaledUpdate {
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  writeId: string;
  writeOrdinal: number;
  durableWriteId: string;
  stageSeq: number;
}

interface ResponseDocumentBuffer {
  docId: string;
  session: ActorSession;
  runtime: RuntimeDocumentState;
  commandName: WriteCommand["command"];
  updates: StagedResponseUpdate[];
  ensureDocumentBeforeCommit: boolean;
  createdDocumentBeforeCommit: boolean;
  discardedBeforeCommit: boolean;
  interactionContext?: InteractionContext;
}

interface ResponseBuffer {
  docs: Map<string, ResponseDocumentBuffer>;
  nextStageSeq: number;
  claimedDiscarded: ResponseClaimDiscardedEntry[];
}

interface BufferedResponseState {
  ownership: "buffered";
  lifecycle: Extract<MutationLifecycle, { phase: "buffered" }>;
  buffer: ResponseBuffer;
}

interface CommittingResponseState {
  ownership: "committing";
  lifecycle: Extract<
    MutationLifecycle,
    { phase: "buffered" | "journalCommitted" | "liveProjected" }
  >;
  /** Immutable snapshot exclusively owned by this commit attempt. */
  buffer: ResponseBuffer;
  documents: ResponseCommitDocumentResult[];
  promise: Promise<ResponseCommitResult>;
}

type ResponseState =
  | BufferedResponseState
  | CommittingResponseState
  | { ownership: "closed"; lifecycle: Extract<MutationLifecycle, { phase: "closed" }> };

export class ResponseLifecycleError extends Error {
  constructor(readonly detail: ResponseLifecycleErrorDetail) {
    super(responseLifecycleMessage(detail));
    this.name = "ResponseLifecycleError";
  }
}

export function isResponseLifecycleError(error: unknown): error is ResponseLifecycleError {
  return error instanceof ResponseLifecycleError;
}

export function createResponseCommitter(deps: {
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  ensureDocument?: (docId: string) => Promise<void>;
  onLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onTransition?: (event: ResponseCommitterTransitionDetail) => void;
  closedResponseTombstoneCap?: number;
}): ResponseCommitter {
  const { runtimeStore, mutationCommit, ensureDocument, onClaimDiscarded, onTransition } = deps;
  const responses = new Map<string, ResponseState>();
  const CLOSED_RESPONSE_TOMBSTONE_CAP = deps.closedResponseTombstoneCap ?? 256;
  const closedResponseOrder: string[] = [];

  function emit(
    transition: ResponseCommitterTransition,
    responseId: string,
    lifecycle: MutationLifecycle,
    extra: Partial<ResponseCommitterTransitionDetail> = {},
  ): void {
    const journalCommitKind = journalKindFromLifecycle(lifecycle);
    try {
      onTransition?.({
        type: "response_committer",
        transition,
        responseId,
        phase: lifecycleToCommitterPhase(lifecycle),
        ...(journalCommitKind ? { journalCommitKind } : {}),
        ...extra,
      });
    } catch {
      // Observability must not alter mutation lifecycle control flow.
    }
  }

  function bufferThreadId(buffer: ResponseBuffer): string | undefined {
    return buffer.docs.values().next().value?.session.threadId;
  }

  function liveResponseState(responseId: string): ResponseState | undefined {
    return responses.get(responseId);
  }

  function recordClaimedDiscard(buffer: ResponseBuffer, entry: ResponseClaimDiscardedEntry): void {
    const existing = buffer.claimedDiscarded.find(
      (current) => current.documentId === entry.documentId && current.threadId === entry.threadId,
    );
    if (existing) {
      existing.updateCount += entry.updateCount;
      return;
    }
    buffer.claimedDiscarded.push({ ...entry });
  }

  function applyDiscardedClaims(buffer: ResponseBuffer, result: ResponseCommitResult): void {
    if (buffer.claimedDiscarded.length > 0) {
      result.discardedClaims = buffer.claimedDiscarded.map((entry) => ({ ...entry }));
      try {
        onClaimDiscarded?.({
          type: "response_lifecycle",
          code: "claimed_write_discarded",
          responseId: result.responseId,
          documents: result.discardedClaims,
        });
      } catch {
        // Observability must not alter mutation lifecycle control flow.
      }
    }
  }

  return {
    assertCanStage,
    stageUpdate,
    commitResponse,
    rollbackResponse,
    hasBufferedWrites,
    bufferedUpdatesForDoc,
    stagedCreatedDocumentIds,
    dropForThread,
  };

  async function commitResponse(responseId: string): Promise<ResponseCommitResult> {
    const state = responses.get(responseId);
    if (!state) return emptyResponseCommit(responseId);
    if (state.ownership === "closed") {
      throw lifecycleError({ responseId, operation: "commit", state: state.lifecycle.closed });
    }
    if (state.ownership === "committing") return state.promise;

    const owner: CommittingResponseState = {
      ownership: "committing",
      lifecycle: bufferedLifecycle(),
      buffer: snapshotResponseBuffer(state.buffer),
      documents: [],
      promise: undefined as unknown as Promise<ResponseCommitResult>,
    };
    owner.promise = Promise.resolve().then(() => runCommitResponse(responseId, owner));
    responses.set(responseId, owner);
    return owner.promise;
  }

  async function runCommitResponse(
    responseId: string,
    owner: CommittingResponseState,
  ): Promise<ResponseCommitResult> {
    const { buffer } = owner;
    const docBuffers = [...buffer.docs.values()];
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(
        responseId,
        responseStagedCreateOutcome(buffer, [], liveResponseState(responseId)),
      );
      transitionClosed(responseId, owner, "committed", null, bufferThreadId(buffer));
      return result;
    }

    const journalBatch = responseJournalBatch(docBuffers);
    let committedLifecycle = hasCommittedJournalKind(owner.lifecycle) ? owner.lifecycle : null;
    const documents: ResponseCommitDocumentResult[] = [];
    const threadId = bufferThreadId(buffer);

    try {
      if (!committedLifecycle) {
        const journalCommitKind = await transitionJournalCommitted(responseId, owner, journalBatch);
        committedLifecycle = journalCommittedLifecycle(journalCommitKind);
      }

      const journalCommitKind = committedLifecycle.journalCommitKind;
      for (const docBuffer of docBuffers) {
        if (docBuffer.ensureDocumentBeforeCommit) {
          await ensureDocument?.(docBuffer.docId);
        }
        const afterOwnVector = Y.encodeStateVector(docBuffer.runtime.doc);
        const lastTurnId = docBuffer.updates.at(-1)?.turnId;
        const projected = await mutationCommit.projectToLive(docBuffer.runtime, {
          docId: docBuffer.docId,
          commandName: docBuffer.commandName,
          updates: docBuffer.updates,
          afterOwnVector,
          liveOrigin: docBuffer.updates.at(-1)?.liveOrigin ?? { type: "system" },
          turnId: lastTurnId,
          interactionContext: docBuffer.interactionContext,
        });
        if (!projected.ok) throw new Error(projected.response.text);
        runtimeStore.attachRuntime(docBuffer.session, docBuffer.docId, docBuffer.runtime);
        documents.push({
          documentId: docBuffer.docId,
          updateCount: docBuffer.updates.length,
          ...(projected.concurrent.info ? { concurrentEdits: projected.concurrent.info } : {}),
        });
        const partialLifecycle = journalCommittedLifecycle(journalCommitKind);
        assertOwner(responseId, owner);
        owner.lifecycle = partialLifecycle;
        owner.documents = [...documents];
        emit("live_projected", responseId, partialLifecycle, {
          journalCommitKind,
          documentId: docBuffer.docId,
          ...(threadId ? { threadId } : {}),
        });
      }

      const finalLifecycle = liveProjectedLifecycle(journalCommitKind);
      assertOwner(responseId, owner);
      owner.lifecycle = finalLifecycle;
      owner.documents = documents;
      emit("live_projected", responseId, finalLifecycle, {
        journalCommitKind,
        ...(threadId ? { threadId } : {}),
      });

      const result: ResponseCommitResult = {
        responseId,
        documentCount: documents.length,
        updateCount: documents.reduce((total, doc) => total + doc.updateCount, 0),
        documents,
        stagedCreates: responseStagedCreateOutcome(
          buffer,
          docBuffers,
          liveResponseState(responseId),
        ),
      };
      applyDiscardedClaims(buffer, result);
      transitionClosed(responseId, owner, "committed", journalCommitKind, threadId);
      return result;
    } catch (cause) {
      const journalCommitKind = committedLifecycle?.journalCommitKind ?? null;
      if (!journalCommitKind) {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, bufferedLifecycle(), { ...(threadId ? { threadId } : {}) });
        throw responseCommitError(responseId, null, cause, null);
      }
      if (journalCommitKind === "syntheticPending") {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, journalCommittedLifecycle(journalCommitKind), {
          journalCommitKind,
          ...(threadId ? { threadId } : {}),
        });
        throw responseCommitError(responseId, journalCommitKind, cause, null);
      }

      const recoveryFailure = await runtimeStore
        .recoverCommittedResponseProjection(docBuffers)
        .catch((error: unknown) => error);
      if (!recoveryFailure) {
        emit("recovery_succeeded", responseId, journalCommittedLifecycle(journalCommitKind), {
          journalCommitKind,
          ...(threadId ? { threadId } : {}),
        });
        const result = responseCommitResult(
          responseId,
          buffer,
          docBuffers,
          documents,
          liveResponseState(responseId),
        );
        applyDiscardedClaims(buffer, result);
        transitionClosed(responseId, owner, "committed", journalCommitKind, threadId);
        return result;
      }

      emit("recovery_failed", responseId, journalCommittedLifecycle(journalCommitKind), {
        journalCommitKind,
        ...(threadId ? { threadId } : {}),
      });
      await runtimeStore.evictResponseRuntimes(docBuffers, { markLiveDocStale: true });
      emit("evicted", responseId, journalCommittedLifecycle(journalCommitKind), {
        journalCommitKind,
        ...(threadId ? { threadId } : {}),
      });
      throw responseCommitError(responseId, journalCommitKind, cause, recoveryFailure);
    }
  }

  async function transitionJournalCommitted(
    responseId: string,
    owner: CommittingResponseState,
    journalBatch: JournalBatchAppendEntry[],
  ): Promise<JournalCommitKind> {
    const threadId = bufferThreadId(owner.buffer);
    const committed = await mutationCommit.commitJournalBatch(journalBatch);
    const lifecycle = journalCommittedLifecycle(committed.journalCommitKind);
    assertOwner(responseId, owner);
    owner.lifecycle = lifecycle;
    emit("journal_committed", responseId, lifecycle, {
      journalCommitKind: committed.journalCommitKind,
      ...(threadId ? { threadId } : {}),
    });
    return committed.journalCommitKind;
  }

  async function rollbackResponse(responseId: string): Promise<ResponseRollbackResult> {
    const state = responses.get(responseId);
    if (!state) return emptyResponseRollback(responseId);
    if (state.ownership === "closed") {
      throw lifecycleError({ responseId, operation: "rollback", state: state.lifecycle.closed });
    }
    // Rollback is intentionally rejected once commit owns the snapshot. Joining would
    // report a commit result through a rollback API and hide the caller's lifecycle bug.
    if (state.ownership === "committing") {
      throw new Error(`Cannot roll back response ${responseId}: commit is already in progress.`);
    }

    const { buffer } = state;
    const docBuffers = [...buffer.docs.values()];
    const pendingDocBuffers = docBuffers.filter((docBuffer) => docBuffer.updates.length > 0);
    const journalCommitKind = journalKindFromLifecycle(state.lifecycle);
    const threadId = bufferThreadId(buffer);
    emit("rollback", responseId, state.lifecycle, {
      ...(journalCommitKind ? { journalCommitKind } : {}),
      ...(threadId ? { threadId } : {}),
    });

    try {
      if (journalCommitKind) {
        await runtimeStore.recoverCommittedResponseProjection(pendingDocBuffers);
        const result = {
          responseId,
          stagedCreates: responseStagedCreateOutcome(
            buffer,
            pendingDocBuffers,
            liveResponseState(responseId),
          ),
        };
        transitionClosed(responseId, state, "rolledBack", journalCommitKind, threadId);
        return result;
      }

      for (const docBuffer of docBuffers) {
        if (docBuffer.ensureDocumentBeforeCommit) {
          await runtimeStore.evictRuntime(docBuffer.session, docBuffer.docId);
          continue;
        }
        const restored = await runtimeStore.restoreRuntimeFromLive(
          docBuffer.session,
          docBuffer.docId,
          docBuffer.runtime,
          docBuffer.commandName,
        );
        if (isInternalWriteResult(restored)) throw new Error(restored.text);
        runtimeStore.attachRuntime(docBuffer.session, docBuffer.docId, docBuffer.runtime);
      }
      const result = {
        responseId,
        stagedCreates: responseStagedCreateOutcome(buffer, [], liveResponseState(responseId), {
          discardPendingStagedCreates: true,
        }),
      };
      transitionClosed(responseId, state, "rolledBack", null, threadId);
      return result;
    } catch (cause) {
      await runtimeStore.evictResponseRuntimes(docBuffers, {
        markLiveDocStale: journalCommitKind === "durable",
      });
      transitionClosed(responseId, state, "rolledBack", journalCommitKind, threadId);
      throw cause;
    }
  }

  function hasBufferedWrites(responseId: string): boolean {
    const buffer = activeBuffer(responseId);
    if (!buffer) return false;
    return [...buffer.docs.values()].some((doc) => doc.updates.length > 0);
  }

  function bufferedUpdatesForDoc(responseId: string, docId: string): readonly Uint8Array[] {
    return (
      activeBuffer(responseId)
        ?.docs.get(docId)
        ?.updates.map((entry) => entry.update) ?? []
    );
  }

  function stagedCreatedDocumentIds(responseId: string, threadId?: string): readonly string[] {
    const buffer = activeBuffer(responseId);
    if (!buffer) return [];
    return [...buffer.docs.values()]
      .filter(
        (docBuffer) =>
          docBuffer.createdDocumentBeforeCommit &&
          !docBuffer.discardedBeforeCommit &&
          (!threadId || docBuffer.session.threadId === threadId),
      )
      .map((docBuffer) => docBuffer.docId);
  }

  function assertCanStage(input: ResponseStagePreflightInput): void {
    const state = responses.get(input.responseId);
    if (!state || state.ownership === "buffered") return;
    if (state.ownership === "committing") {
      throw new Error(`Cannot stage response ${input.responseId}: commit is already in progress.`);
    }
    throw lifecycleError({
      responseId: input.responseId,
      operation: "stage",
      state: state.lifecycle.closed,
      ...(input.docId ? { documentId: input.docId } : {}),
      ...(input.session?.threadId ? { threadId: input.session.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.writeId ? { writeId: input.writeId } : {}),
    });
  }

  function stageUpdate(input: ResponseStageUpdateInput): void {
    assertCanStage({
      responseId: input.responseId,
      docId: input.docId,
      session: input.session,
      turnId: input.turnId,
      writeId: input.durableWriteId,
    });
    let buffer = activeBuffer(input.responseId);
    if (!buffer) {
      buffer = { docs: new Map(), nextStageSeq: 0, claimedDiscarded: [] };
      const lifecycle = { phase: "buffered" } as const;
      responses.set(input.responseId, { ownership: "buffered", lifecycle, buffer });
    }

    let docBuffer = buffer.docs.get(input.docId);
    if (!docBuffer) {
      docBuffer = {
        docId: input.docId,
        session: input.session,
        runtime: input.runtime,
        commandName: input.commandName,
        updates: [],
        ensureDocumentBeforeCommit: input.ensureDocumentBeforeCommit ?? false,
        createdDocumentBeforeCommit: input.createdDocumentBeforeCommit,
        discardedBeforeCommit: false,
      };
      buffer.docs.set(input.docId, docBuffer);
    }

    docBuffer.commandName = input.commandName;
    docBuffer.ensureDocumentBeforeCommit =
      docBuffer.ensureDocumentBeforeCommit || (input.ensureDocumentBeforeCommit ?? false);
    docBuffer.createdDocumentBeforeCommit =
      docBuffer.createdDocumentBeforeCommit || input.createdDocumentBeforeCommit;
    docBuffer.discardedBeforeCommit = false;
    const interactionContext = responseInteractionContext(docBuffer, input.interactionContext);
    if (input.interactionContext?.mode === "threadPeer" || !docBuffer.interactionContext) {
      docBuffer.interactionContext = interactionContext;
    }
    docBuffer.updates.push({
      update: input.update,
      meta: input.meta,
      mutation: {
        threadId: input.session.threadId,
        turnId: input.turnId,
        writeId:
          input.durableWriteId ??
          `${input.session.threadId}:${input.turnId}:${buffer.nextStageSeq}`,
        wId: input.writeOrdinal,
        ...(input.updateKind ? { updateKind: input.updateKind } : {}),
        ...mutationMode(interactionContext),
      },
      writeId: input.writeId ?? "w0",
      writeOrdinal: input.writeOrdinal ?? 0,
      durableWriteId:
        input.durableWriteId ?? `${input.session.threadId}:${input.turnId}:${buffer.nextStageSeq}`,
      liveOrigin: input.liveOrigin,
      turnId: input.turnId,
      stageSeq: buffer.nextStageSeq,
    });
    buffer.nextStageSeq += 1;
    const stagedState = responses.get(input.responseId);
    if (stagedState?.ownership === "buffered") {
      emit("stage", input.responseId, stagedState.lifecycle, {
        documentId: input.docId,
        threadId: input.session.threadId,
      });
    }
  }

  function responseJournalBatch(
    docBuffers: readonly ResponseDocumentBuffer[],
  ): JournalBatchAppendEntry[] {
    return docBuffers
      .flatMap((docBuffer) =>
        docBuffer.updates.map((entry) => ({
          stageSeq: entry.stageSeq,
          journalEntry: {
            docId: docBuffer.docId,
            update: entry.update,
            meta: entry.meta,
            ...(entry.mutation ? { mutation: entry.mutation } : {}),
          },
        })),
      )
      .sort((left, right) => left.stageSeq - right.stageSeq)
      .map((entry) => entry.journalEntry);
  }

  function dropForThread(docId: string, threadId: string): void {
    for (const [responseId, state] of [...responses]) {
      if (state.ownership !== "buffered") continue;
      const buffer = state.buffer;
      const docBuffer = buffer.docs.get(docId);
      let claimedWriteDropped = false;
      let droppedClaimedCount = 0;
      if (docBuffer) {
        const claimedUpdates = docBuffer.updates.filter(
          (entry) => entry.mutation?.threadId === threadId,
        );
        claimedWriteDropped = claimedUpdates.length > 0;
        droppedClaimedCount = claimedUpdates.length;
        docBuffer.updates = docBuffer.updates.filter(
          (entry) => entry.mutation?.threadId !== threadId,
        );
        if (docBuffer.session.threadId === threadId) {
          if (docBuffer.createdDocumentBeforeCommit && !journalKindFromLifecycle(state.lifecycle)) {
            docBuffer.discardedBeforeCommit = true;
          }
        }
        if (docBuffer.updates.length === 0 && !docBuffer.discardedBeforeCommit) {
          buffer.docs.delete(docId);
        }
      }
      if (!responseBufferHasPendingOutcome(buffer)) {
        if (claimedWriteDropped) {
          transitionClosed(
            responseId,
            state,
            "rolledBack",
            journalKindFromLifecycle(state.lifecycle),
            threadId,
          );
        } else {
          responses.delete(responseId);
          emit("drop_for_thread", responseId, state.lifecycle, { documentId: docId, threadId });
        }
        continue;
      }
      if (droppedClaimedCount > 0) {
        recordClaimedDiscard(buffer, {
          documentId: docId,
          threadId,
          updateCount: droppedClaimedCount,
        });
        emit("drop_for_thread", responseId, state.lifecycle, {
          documentId: docId,
          threadId,
          droppedUpdateCount: droppedClaimedCount,
        });
      }
    }
  }

  function activeBuffer(responseId: string): ResponseBuffer | undefined {
    const state = responses.get(responseId);
    return state?.ownership === "buffered" ? state.buffer : undefined;
  }

  function assertOwner(
    responseId: string,
    owner: BufferedResponseState | CommittingResponseState,
  ): void {
    if (responses.get(responseId) !== owner) {
      throw new Error(`Response ${responseId} lifecycle ownership changed unexpectedly.`);
    }
  }

  function transitionClosed(
    responseId: string,
    owner: BufferedResponseState | CommittingResponseState,
    closed: ResponseLifecycleClosedState,
    journalCommitKind: JournalCommitKind | null,
    threadId?: string,
  ): void {
    assertOwner(responseId, owner);
    const lifecycle = closedLifecycle(closed, journalCommitKind);
    responses.set(responseId, { ownership: "closed", lifecycle });
    emit("closed", responseId, lifecycle, {
      closedOutcome: closed,
      ...(threadId ? { threadId } : {}),
    });
    if (!closedResponseOrder.includes(responseId)) {
      closedResponseOrder.push(responseId);
    }
    while (closedResponseOrder.length > CLOSED_RESPONSE_TOMBSTONE_CAP) {
      const evicted = closedResponseOrder.shift();
      if (evicted) responses.delete(evicted);
    }
  }

  function lifecycleError(detail: Omit<ResponseLifecycleErrorDetail, "type" | "code">): Error {
    const event: ResponseLifecycleErrorDetail = {
      type: "response_lifecycle",
      code: "response_closed",
      ...detail,
    };
    deps.onLifecycleError?.(event);
    return new ResponseLifecycleError(event);
  }
}

function responseLifecycleMessage(detail: ResponseLifecycleErrorDetail): string {
  const state = detail.state === "rolledBack" ? "rolled back" : detail.state;
  const operation =
    detail.operation === "stage"
      ? "stage another write for"
      : detail.operation === "commit"
        ? "commit"
        : "roll back";
  return `Response lifecycle closed: response ${detail.responseId} is already ${state}; cannot ${operation} this response. Start a new model response before writing again.`;
}

function snapshotResponseBuffer(buffer: ResponseBuffer): ResponseBuffer {
  return {
    nextStageSeq: buffer.nextStageSeq,
    claimedDiscarded: buffer.claimedDiscarded.map((entry) => ({ ...entry })),
    docs: new Map(
      [...buffer.docs]
        .filter(([, docBuffer]) => docBuffer.updates.length > 0)
        .map(([docId, docBuffer]) => [
          docId,
          { ...docBuffer, updates: docBuffer.updates.map((update) => ({ ...update })) },
        ]),
    ),
  };
}

function responseBufferHasPendingOutcome(buffer: ResponseBuffer): boolean {
  return [...buffer.docs.values()].some(
    (docBuffer) => docBuffer.updates.length > 0 || docBuffer.discardedBeforeCommit,
  );
}

function responseCommitError(
  responseId: string,
  journalCommitKind: JournalCommitKind | null,
  cause: unknown,
  recoveryFailure: unknown,
): Error {
  const phase =
    journalCommitKind === "durable"
      ? "after the durable journal batch was committed"
      : journalCommitKind === "syntheticPending"
        ? "after only a synthetic pending journal batch was accepted"
        : "before the journal batch was committed";
  const recovery = recoveryFailure
    ? ` Recovery from the committed journal also failed: ${errorMessage(recoveryFailure)}.`
    : journalCommitKind === "durable"
      ? " The affected runtime docs were invalidated and will rebuild from live+journal on next access."
      : " The affected runtime docs were invalidated; the response buffer is still available for retry or rollback.";
  return new Error(
    `Failed to commit response ${responseId} ${phase}: ${errorMessage(cause)}.${recovery}`,
    { cause },
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyResponseCommit(
  responseId: string,
  stagedCreates: ResponseStagedCreateOutcome = { committed: [], discarded: [] },
): ResponseCommitResult {
  return { responseId, documentCount: 0, updateCount: 0, documents: [], stagedCreates };
}

function emptyResponseRollback(responseId: string): ResponseRollbackResult {
  return { responseId, stagedCreates: { committed: [], discarded: [] } };
}

function responseStagedCreateOutcome(
  buffer: ResponseBuffer,
  committedDocBuffers: readonly ResponseDocumentBuffer[],
  state: ResponseState | undefined,
  options: { discardPendingStagedCreates?: boolean } = {},
): ResponseStagedCreateOutcome {
  const journalCommitted =
    state?.ownership === "committing" && hasCommittedJournalKind(state.lifecycle);
  const committed = stagedCreateDocIds(committedDocBuffers);
  const discarded = stagedCreateDocIds(
    [...buffer.docs.values()].filter(
      (docBuffer) =>
        docBuffer.discardedBeforeCommit ||
        (options.discardPendingStagedCreates &&
          docBuffer.createdDocumentBeforeCommit &&
          !journalCommitted),
    ),
  );
  return { committed, discarded };
}

function stagedCreateDocIds(docBuffers: readonly ResponseDocumentBuffer[]): string[] {
  return [
    ...new Set(
      docBuffers
        .filter((docBuffer) => docBuffer.createdDocumentBeforeCommit)
        .map((docBuffer) => docBuffer.docId),
    ),
  ];
}

function responseCommitResult(
  responseId: string,
  buffer: ResponseBuffer,
  docBuffers: readonly ResponseDocumentBuffer[],
  knownDocuments: ResponseCommitDocumentResult[] = [],
  state: ResponseState | undefined,
): ResponseCommitResult {
  const documentsById = new Map(
    knownDocuments.map((document) => [document.documentId, document] as const),
  );
  for (const docBuffer of docBuffers) {
    if (docBuffer.updates.length === 0 || documentsById.has(docBuffer.docId)) continue;
    documentsById.set(docBuffer.docId, {
      documentId: docBuffer.docId,
      updateCount: docBuffer.updates.length,
    });
  }
  return {
    responseId,
    documentCount: documentsById.size,
    updateCount: docBuffers.reduce((total, docBuffer) => total + docBuffer.updates.length, 0),
    documents: [...documentsById.values()],
    stagedCreates: responseStagedCreateOutcome(buffer, docBuffers, state),
  };
}
