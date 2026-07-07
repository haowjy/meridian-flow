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
  type ResponseMutationAggregate,
  type Result,
  responseAggregateToCommitFields,
} from "./mutation-outcome.js";
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

export type { Result } from "./mutation-outcome.js";

export interface CommitFailure {
  responseId: string;
  completedPhases: ReturnType<typeof lifecycleToCommitterPhase>[];
  journalCommitKind: JournalCommitKind | null;
  cause: unknown;
  recoveryFailure?: unknown;
}

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

interface ActiveResponseState {
  lifecycle: Extract<
    MutationLifecycle,
    { phase: "buffered" | "journalCommitted" | "liveProjected" }
  >;
  buffer: ResponseBuffer;
  documents: ResponseCommitDocumentResult[];
  /** Joins concurrent commitResponse callers before the first journal append lands. */
  commitInFlight?: Promise<ResponseCommitResult>;
}

type ResponseState =
  | ActiveResponseState
  | { lifecycle: Extract<MutationLifecycle, { phase: "closed" }> };

function isActiveState(state: ResponseState): state is ActiveResponseState {
  return state.lifecycle.phase !== "closed";
}

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

  function buildResponseAggregate(
    buffer: ResponseBuffer,
    lifecycle: MutationLifecycle,
  ): ResponseMutationAggregate {
    return {
      lifecycle,
      discardedClaims: buffer.claimedDiscarded.map((entry) => ({ ...entry })),
    };
  }

  function applyAggregateToCommitResult(
    aggregate: ResponseMutationAggregate,
    result: ResponseCommitResult,
  ): void {
    if (aggregate.discardedClaims.length > 0) {
      Object.assign(result, responseAggregateToCommitFields(aggregate));
      try {
        onClaimDiscarded?.({
          type: "response_lifecycle",
          code: "claimed_write_discarded",
          responseId: result.responseId,
          documents: aggregate.discardedClaims,
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
    if (!isActiveState(state)) {
      throw lifecycleError({ responseId, operation: "commit", state: state.lifecycle.closed });
    }

    if (state.commitInFlight) {
      return state.commitInFlight;
    }

    const commitInFlight = Promise.resolve().then(() => runCommitResponse(responseId, state));
    setActiveState(responseId, { ...state, commitInFlight });
    try {
      return await commitInFlight;
    } finally {
      const current = responses.get(responseId);
      if (current && isActiveState(current) && current.commitInFlight === commitInFlight) {
        const { commitInFlight: _inFlight, ...rest } = current;
        setActiveState(responseId, rest);
      }
    }
  }

  async function runCommitResponse(
    responseId: string,
    state: ActiveResponseState,
  ): Promise<ResponseCommitResult> {
    const { buffer } = state;
    const docBuffers = snapshotCommitDocBuffers(buffer);
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(
        responseId,
        responseStagedCreateOutcome(buffer, [], liveResponseState(responseId)),
      );
      transitionClosed(responseId, "committed", null, bufferThreadId(buffer));
      return result;
    }

    const journalBatch = responseJournalBatch(docBuffers);
    let committedLifecycle = hasCommittedJournalKind(state.lifecycle) ? state.lifecycle : null;
    const documents: ResponseCommitDocumentResult[] = [];
    const threadId = bufferThreadId(buffer);

    try {
      if (!committedLifecycle) {
        const journalResult = await transitionJournalCommitted(responseId, buffer, journalBatch);
        if (!journalResult.ok) throw journalResult.error.cause;
        committedLifecycle = journalCommittedLifecycle(journalResult.value.journalCommitKind);
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
        setActiveState(responseId, {
          lifecycle: partialLifecycle,
          buffer,
          documents: [...documents],
        });
        emit("live_projected", responseId, partialLifecycle, {
          journalCommitKind,
          documentId: docBuffer.docId,
          ...(threadId ? { threadId } : {}),
        });
      }

      const finalLifecycle = liveProjectedLifecycle(journalCommitKind);
      setActiveState(responseId, {
        lifecycle: finalLifecycle,
        buffer,
        documents,
      });
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
      const aggregate = buildResponseAggregate(buffer, finalLifecycle);
      applyAggregateToCommitResult(aggregate, result);
      transitionClosed(responseId, "committed", journalCommitKind, threadId);
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
        const aggregate = buildResponseAggregate(buffer, liveProjectedLifecycle(journalCommitKind));
        applyAggregateToCommitResult(aggregate, result);
        transitionClosed(responseId, "committed", journalCommitKind, threadId);
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
    buffer: ResponseBuffer,
    journalBatch: JournalBatchAppendEntry[],
  ): Promise<Result<{ journalCommitKind: JournalCommitKind }, CommitFailure>> {
    const threadId = bufferThreadId(buffer);
    let committed: Awaited<ReturnType<MutationCommit["commitJournalBatch"]>>;
    try {
      committed = await mutationCommit.commitJournalBatch(journalBatch);
    } catch (cause) {
      return {
        ok: false,
        error: {
          responseId,
          completedPhases: ["buffered"],
          journalCommitKind: null,
          cause,
        },
      };
    }
    const lifecycle = journalCommittedLifecycle(committed.journalCommitKind);
    setActiveState(responseId, {
      lifecycle,
      buffer,
      documents: [],
    });
    emit("journal_committed", responseId, lifecycle, {
      journalCommitKind: committed.journalCommitKind,
      ...(threadId ? { threadId } : {}),
    });
    return { ok: true, value: { journalCommitKind: committed.journalCommitKind } };
  }

  async function rollbackResponse(responseId: string): Promise<ResponseRollbackResult> {
    const state = responses.get(responseId);
    if (!state) return emptyResponseRollback(responseId);
    if (!isActiveState(state)) {
      throw lifecycleError({ responseId, operation: "rollback", state: state.lifecycle.closed });
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
        transitionClosed(responseId, "rolledBack", journalCommitKind, threadId);
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
      transitionClosed(responseId, "rolledBack", null, threadId);
      return result;
    } catch (cause) {
      await runtimeStore.evictResponseRuntimes(docBuffers, {
        markLiveDocStale: journalCommitKind === "durable",
      });
      transitionClosed(responseId, "rolledBack", journalCommitKind, threadId);
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
    if (!state || isActiveState(state)) return;
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
      const lifecycle = bufferedLifecycle();
      responses.set(input.responseId, { lifecycle, buffer, documents: [] });
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
    if (stagedState && isActiveState(stagedState)) {
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
      if (!isActiveState(state)) continue;
      // Journal/live commit paths own immutable snapshots; only buffered staging is droppable.
      if (state.lifecycle.phase !== "buffered") continue;
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
    return state && isActiveState(state) ? state.buffer : undefined;
  }

  function setActiveState(responseId: string, state: ActiveResponseState): void {
    responses.set(responseId, state);
  }

  function transitionClosed(
    responseId: string,
    closed: ResponseLifecycleClosedState,
    journalCommitKind: JournalCommitKind | null,
    threadId?: string,
  ): void {
    const lifecycle = closedLifecycle(closed, journalCommitKind);
    responses.set(responseId, { lifecycle });
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

function snapshotCommitDocBuffers(buffer: ResponseBuffer): ResponseDocumentBuffer[] {
  return [...buffer.docs.values()]
    .filter((docBuffer) => docBuffer.updates.length > 0)
    .map((docBuffer) => ({
      ...docBuffer,
      updates: docBuffer.updates.map((update) => ({ ...update })),
    }));
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
    state !== undefined && isActiveState(state) && hasCommittedJournalKind(state.lifecycle);
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
