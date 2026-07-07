// Response committer: journal/live mutation projection and explicit response lifecycle states.
import * as Y from "yjs";

import {
  applyConcurrentUpdates,
  type BlockSnapshot,
  type ConcurrentDetectionResult,
  computeEcho,
  snapshotBlocks,
} from "../apply/echo.js";
import type {
  ApplyEchoHunk,
  ConcurrentEditInfo,
  ConcurrentUpdate,
  ConcurrentUpdateOrigin,
} from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalCommitKind,
  UpdateJournal,
} from "../ports/update-journal.js";
import { effectiveYjsUpdate } from "../yjs-update.js";
import { withLiveDocument } from "./coordinator.js";
import { mutationMode, responseInteractionContext } from "./interaction-mode.js";
import { type InternalWriteResult, isInternalWriteResult } from "./internal-result.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  ResponseClaimDiscardedEntry,
  ResponseCommitDocumentResult,
  ResponseCommitResult,
  ResponseCommitterPhase,
  ResponseCommitterTransition,
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleClosedState,
  ResponseLifecycleErrorDetail,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  WriteCommand,
} from "./types.js";

// --- Result algebra (commit transitions) ---

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface CommitFailure {
  responseId: string;
  completedPhases: ResponseCommitterPhase[];
  journalCommitKind: JournalCommitKind | null;
  cause: unknown;
  recoveryFailure?: unknown;
}

// --- Mutation commit (journal + live projection) ---

export interface MutationCommitRuntime {
  doc: Y.Doc;
}

export interface SyncedMutationSummary {
  echo: ApplyEchoHunk[];
  concurrentEdits?: ConcurrentEditInfo;
  reconciled: boolean;
}

export interface MutationEchoInput {
  runtime: MutationCommitRuntime;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  afterSnapshot?: readonly BlockSnapshot[];
}

export interface JournaledUpdate {
  update: Uint8Array;
  meta: UpdateMeta;
  mutation?: JournalBatchAppendEntry["mutation"];
}

export interface LiveUpdateCommitInput {
  docId: string;
  commandName: WriteCommand["command"];
  updates: readonly JournaledUpdate[];
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
  interactionContext?: InteractionContext;
}

export interface LiveProjectionInput extends LiveUpdateCommitInput {
  turnId?: string;
}

export interface LocalMutationSyncInput {
  docId: string;
  commandName: WriteCommand["command"];
  runtime: MutationCommitRuntime;
  update: Uint8Array;
  meta?: UpdateMeta;
  mutation?: JournaledUpdate["mutation"];
  afterOwnVector: Uint8Array;
  liveOrigin: ConcurrentUpdateOrigin;
  before: readonly BlockSnapshot[];
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  ownTurnId?: string;
  interactionContext?: InteractionContext;
}

type JournalBatchCommit = {
  results: JournalBatchAppendResult[];
  journalCommitKind: JournalCommitKind;
};

type LiveCommitResult =
  | { ok: true; concurrentUpdates: ConcurrentUpdate[]; journalResults?: JournalBatchAppendResult[] }
  | { ok: false; response: InternalWriteResult };

type MutationSyncResult =
  | { ok: true; summary: SyncedMutationSummary; journalResults?: JournalBatchAppendResult[] }
  | { ok: false; response: InternalWriteResult };

type LiveProjectionResult =
  | { ok: true; concurrent: ConcurrentDetectionResult }
  | { ok: false; response: InternalWriteResult };

export interface MutationCommit {
  syncAfterLocalMutation(input: LocalMutationSyncInput): Promise<MutationSyncResult>;
  commitImmediate(input: LiveUpdateCommitInput): Promise<LiveCommitResult>;
  commitJournalBatch(entries: readonly JournalBatchAppendEntry[]): Promise<JournalBatchCommit>;
  projectToLive(
    runtime: MutationCommitRuntime,
    input: LiveProjectionInput,
  ): Promise<LiveProjectionResult>;
  summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent?: ConcurrentDetectionResult,
  ): SyncedMutationSummary;
  detectConcurrentEdits(input: {
    docId: string;
    runtime: MutationCommitRuntime;
    agentUpdate: Uint8Array;
    interactionContext?: InteractionContext;
    preOwnSnapshot?: Uint8Array;
    ownTurnId?: string;
  }): Promise<ConcurrentDetectionResult>;
}

export function createMutationCommit(deps: {
  journal: UpdateJournal;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
}): MutationCommit {
  const { journal, coordinator, model, codec } = deps;

  return {
    syncAfterLocalMutation,
    commitImmediate,
    commitJournalBatch,
    projectToLive,
    summarizeMutationEcho,
    detectConcurrentEdits,
  };

  async function syncAfterLocalMutation(
    input: LocalMutationSyncInput,
  ): Promise<MutationSyncResult> {
    const detection = detectionBaseline(input.runtime, input.interactionContext?.baselineSnapshot);
    try {
      const journalCommit = input.meta
        ? await commitJournalBatch([
            {
              docId: input.docId,
              update: input.update,
              meta: input.meta,
              ...(input.mutation ? { mutation: input.mutation } : {}),
            },
          ])
        : undefined;
      const committed = await mergeCommittedUpdateToLive({
        docId: input.docId,
        commandName: input.commandName,
        update: input.update,
        afterOwnVector: input.afterOwnVector,
        concurrentBaselineVector: detection.vector,
        concurrentBaselineDoc: detection.doc,
        liveOrigin: input.liveOrigin,
        afterJournalId: input.interactionContext?.afterJournalId,
        attemptId: input.interactionContext?.attemptId,
      });
      if (!committed.ok) return { ok: false, response: committed.response };
      const concurrent = applyConcurrentOnDoc(
        detection.doc,
        input.runtime,
        committed.concurrentUpdates,
        detection.vector,
        input.ownTurnId,
      );
      return {
        ok: true,
        summary: summarizeMutationEcho(input, concurrent),
        journalResults: journalCommit?.results,
      };
    } finally {
      detection.destroy?.();
    }
  }

  function summarizeMutationEcho(
    input: MutationEchoInput,
    concurrent: ConcurrentDetectionResult = { touchedHashes: new Set() },
  ): SyncedMutationSummary {
    const after =
      input.afterSnapshot ?? snapshotBlocks(toDocHandle(input.runtime.doc), model, codec);
    const echo = computeEcho({
      before: input.before,
      after,
      agentTouchedHashes: input.touchedHashes,
      agentDeletedHashes: input.deletedHashes,
    });
    return {
      echo,
      concurrentEdits: concurrent.info,
      reconciled: echo.some((hunk) => hunk.mode === "full"),
    };
  }

  async function detectConcurrentEdits(input: {
    docId: string;
    runtime: MutationCommitRuntime;
    agentUpdate: Uint8Array;
    interactionContext?: InteractionContext;
    preOwnSnapshot?: Uint8Array;
    ownTurnId?: string;
  }): Promise<ConcurrentDetectionResult> {
    const detection = detectionBaseline(input.runtime, input.interactionContext?.baselineSnapshot);
    const preOwnDoc = input.preOwnSnapshot ? docFromSnapshot(input.preOwnSnapshot) : undefined;
    try {
      const updates = await concurrentUpdatesSince(
        coordinator,
        input.docId,
        preOwnDoc ?? input.runtime.doc,
        detection.doc,
        detection.vector,
        input.interactionContext?.afterJournalId,
        input.interactionContext?.attemptId,
      );
      return applyConcurrentOnDoc(
        detection.doc,
        input.runtime,
        updates,
        detection.vector,
        input.ownTurnId,
      );
    } finally {
      preOwnDoc?.destroy();
      detection.destroy?.();
    }
  }

  async function commitImmediate(input: LiveUpdateCommitInput): Promise<LiveCommitResult> {
    const journalCommit = await commitJournalBatch(journalEntries(input));
    const committed = await mergeCommittedUpdatesToLive(input);
    return committed.ok ? { ...committed, journalResults: journalCommit.results } : committed;
  }

  async function commitJournalBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchCommit> {
    const results = await journal.appendBatch(entries);
    const journalCommitKind = results.some(
      (result) => result.journalCommitKind === "syntheticPending",
    )
      ? "syntheticPending"
      : "durable";
    return { results, journalCommitKind };
  }

  async function projectToLive(
    runtime: MutationCommitRuntime,
    input: LiveProjectionInput,
  ): Promise<LiveProjectionResult> {
    const detection = detectionBaseline(runtime, input.interactionContext?.baselineSnapshot);
    try {
      const committed = await mergeCommittedUpdatesToLive({
        ...input,
        concurrentBaselineVector: detection.vector,
        concurrentBaselineDoc: detection.doc,
      });
      if (!committed.ok) return { ok: false, response: committed.response };
      const concurrent = applyConcurrentOnDoc(
        detection.doc,
        runtime,
        committed.concurrentUpdates,
        detection.vector,
        input.turnId,
      );
      return { ok: true, concurrent };
    } finally {
      detection.destroy?.();
    }
  }

  async function mergeCommittedUpdatesToLive(
    input: LiveUpdateCommitInput & {
      concurrentBaselineVector?: Uint8Array;
      concurrentBaselineDoc?: Y.Doc;
    },
  ): Promise<LiveCommitResult> {
    return mergeCommittedUpdateToLive({
      docId: input.docId,
      commandName: input.commandName,
      update: mergeUpdates(input.updates.map((entry) => entry.update)),
      afterOwnVector: input.afterOwnVector,
      concurrentBaselineVector: input.concurrentBaselineVector,
      concurrentBaselineDoc: input.concurrentBaselineDoc,
      liveOrigin: input.liveOrigin,
      afterJournalId: input.interactionContext?.afterJournalId,
      attemptId: input.interactionContext?.attemptId,
    });
  }

  async function mergeCommittedUpdateToLive(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
    concurrentBaselineVector?: Uint8Array;
    concurrentBaselineDoc?: Y.Doc;
    liveOrigin: ConcurrentUpdateOrigin;
    afterJournalId?: number;
    attemptId?: string;
  }): Promise<LiveCommitResult> {
    const concurrentUpdates = await mergeUpdateAndCaptureConcurrent(input);
    if (isInternalWriteResult(concurrentUpdates)) return { ok: false, response: concurrentUpdates };
    return { ok: true, concurrentUpdates };
  }

  async function mergeUpdateAndCaptureConcurrent(input: {
    docId: string;
    commandName: WriteCommand["command"];
    update: Uint8Array;
    afterOwnVector: Uint8Array;
    concurrentBaselineVector?: Uint8Array;
    concurrentBaselineDoc?: Y.Doc;
    liveOrigin: ConcurrentUpdateOrigin;
    afterJournalId?: number;
    attemptId?: string;
  }): Promise<ConcurrentUpdate[] | InternalWriteResult> {
    let concurrentUpdates: ConcurrentUpdate[] = [];
    const response = await withLiveDocument(
      coordinator,
      input.docId,
      input.commandName,
      input.docId,
      async (liveDoc) => {
        const baseline = input.concurrentBaselineVector ?? input.afterOwnVector;
        concurrentUpdates = await concurrentUpdatesSince(
          coordinator,
          input.docId,
          liveDoc,
          input.concurrentBaselineDoc,
          baseline,
          input.afterJournalId,
          input.attemptId,
        );
        Y.applyUpdate(liveDoc, input.update, input.liveOrigin);
        return null;
      },
    );
    if (isInternalWriteResult(response)) return response;
    return concurrentUpdates;
  }

  function applyConcurrentOnDoc(
    detectionDoc: Y.Doc,
    runtime: MutationCommitRuntime,
    updates: readonly ConcurrentUpdate[],
    _syncVector: Uint8Array,
    turnId: string | undefined,
  ): ConcurrentDetectionResult {
    if (updates.length === 0) return { touchedHashes: new Set() };
    const result = applyConcurrentUpdates(
      toDocHandle(detectionDoc),
      model,
      codec,
      updates,
      turnId ? agentUpdateOrigin(turnId) : undefined,
    );
    if (detectionDoc !== runtime.doc) {
      for (const item of updates) {
        if (item.update.length > 0) Y.applyUpdate(runtime.doc, item.update, item.origin);
      }
    }
    return result;
  }

  function detectionBaseline(
    runtime: MutationCommitRuntime,
    baselineSnapshot: Uint8Array | undefined,
  ): { doc: Y.Doc; vector: Uint8Array; destroy?: () => void } {
    if (!baselineSnapshot) return { doc: runtime.doc, vector: Y.encodeStateVector(runtime.doc) };
    const detectionDoc = docFromSnapshot(baselineSnapshot);
    return {
      doc: detectionDoc,
      vector: Y.encodeStateVector(detectionDoc),
      destroy: () => detectionDoc.destroy(),
    };
  }
}

// --- Response committer state machine ---

export interface ResponseStaging {
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

type ActiveResponseState =
  | { phase: "buffered"; buffer: ResponseBuffer }
  | {
      phase: "journalCommitted";
      journalCommitKind: JournalCommitKind;
      buffer: ResponseBuffer;
      documents: ResponseCommitDocumentResult[];
    }
  | {
      phase: "liveProjected";
      journalCommitKind: JournalCommitKind;
      buffer: ResponseBuffer;
      documents: ResponseCommitDocumentResult[];
    };

type ResponseState =
  | ActiveResponseState
  | { phase: "closed"; outcome: ResponseLifecycleClosedState };

export class ResponseLifecycleError extends Error {
  constructor(readonly detail: ResponseLifecycleErrorDetail) {
    super(responseLifecycleMessage(detail));
    this.name = "ResponseLifecycleError";
  }
}

export function isResponseLifecycleError(error: unknown): error is ResponseLifecycleError {
  return error instanceof ResponseLifecycleError;
}

/** @deprecated Use createResponseCommitter */
export const createResponseStaging = createResponseCommitter;

export function createResponseCommitter(deps: {
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  ensureDocument?: (docId: string) => Promise<void>;
  onLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onTransition?: (event: ResponseCommitterTransitionDetail) => void;
  closedResponseTombstoneCap?: number;
}): ResponseStaging {
  const { runtimeStore, mutationCommit, ensureDocument, onClaimDiscarded, onTransition } = deps;
  const responses = new Map<string, ResponseState>();
  const CLOSED_RESPONSE_TOMBSTONE_CAP = deps.closedResponseTombstoneCap ?? 256;
  const closedResponseOrder: string[] = [];

  function emit(
    transition: ResponseCommitterTransition,
    responseId: string,
    phase: ResponseCommitterPhase,
    extra: Partial<ResponseCommitterTransitionDetail> = {},
  ): void {
    onTransition?.({
      type: "response_committer",
      transition,
      responseId,
      phase,
      ...extra,
    });
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

  function finalizeClaimedDiscards(
    responseId: string,
    buffer: ResponseBuffer,
    result: ResponseCommitResult,
  ): void {
    if (buffer.claimedDiscarded.length === 0) return;
    const documents = buffer.claimedDiscarded.map((entry) => ({ ...entry }));
    result.discardedClaims = documents;
    onClaimDiscarded?.({
      type: "response_lifecycle",
      code: "claimed_write_discarded",
      responseId,
      documents,
    });
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
    if (state.phase === "closed") {
      throw lifecycleError({ responseId, operation: "commit", state: state.outcome });
    }

    const buffer = state.buffer;
    const docBuffers = [...buffer.docs.values()].filter(
      (docBuffer) => docBuffer.updates.length > 0,
    );
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(
        responseId,
        responseStagedCreateOutcome(buffer, [], state),
      );
      transitionClosed(responseId, "committed");
      return result;
    }

    const journalBatch = responseJournalBatch(docBuffers);
    let journalCommitKind = journalKindFromState(state);
    const documents: ResponseCommitDocumentResult[] =
      state.phase === "journalCommitted" || state.phase === "liveProjected"
        ? [...state.documents]
        : [];

    try {
      if (!journalCommitKind) {
        const journalResult = await transitionJournalCommitted(responseId, buffer, journalBatch);
        if (!journalResult.ok) throw journalResult.error.cause;
        journalCommitKind = journalResult.value.journalCommitKind;
      }

      const projectionStart = documents.length;
      for (let index = projectionStart; index < docBuffers.length; index += 1) {
        const docBuffer = docBuffers[index];
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
        setActiveState(responseId, {
          phase: "journalCommitted",
          journalCommitKind: journalCommitKind!,
          buffer,
          documents: [...documents],
        });
        emit("live_projected", responseId, "journalCommitted", {
          journalCommitKind: journalCommitKind!,
          documentId: docBuffer.docId,
        });
      }

      setActiveState(responseId, {
        phase: "liveProjected",
        journalCommitKind: journalCommitKind!,
        buffer,
        documents,
      });
      emit("live_projected", responseId, "liveProjected", {
        journalCommitKind: journalCommitKind!,
      });

      const result: ResponseCommitResult = {
        responseId,
        documentCount: documents.length,
        updateCount: documents.reduce((total, doc) => total + doc.updateCount, 0),
        documents,
        stagedCreates: responseStagedCreateOutcome(buffer, docBuffers, state),
      };
      finalizeClaimedDiscards(responseId, buffer, result);
      transitionClosed(responseId, "committed");
      return result;
    } catch (cause) {
      if (!journalCommitKind) {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, "buffered");
        throw responseCommitError(responseId, null, cause, null);
      }
      if (journalCommitKind === "syntheticPending") {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, "journalCommitted", { journalCommitKind });
        throw responseCommitError(responseId, journalCommitKind, cause, null);
      }

      const recoveryFailure = await runtimeStore
        .recoverCommittedResponseProjection(docBuffers)
        .catch((error: unknown) => error);
      if (!recoveryFailure) {
        emit("recovery_succeeded", responseId, "journalCommitted", { journalCommitKind });
        const result = responseCommitResult(responseId, buffer, docBuffers, documents, state);
        finalizeClaimedDiscards(responseId, buffer, result);
        transitionClosed(responseId, "committed");
        return result;
      }

      emit("recovery_failed", responseId, "journalCommitted", { journalCommitKind });
      await runtimeStore.evictResponseRuntimes(docBuffers, { markLiveDocStale: true });
      emit("evicted", responseId, "journalCommitted", { journalCommitKind });
      throw responseCommitError(responseId, journalCommitKind, cause, recoveryFailure);
    }
  }

  async function transitionJournalCommitted(
    responseId: string,
    buffer: ResponseBuffer,
    journalBatch: JournalBatchAppendEntry[],
  ): Promise<Result<{ journalCommitKind: JournalCommitKind }, CommitFailure>> {
    try {
      const committed = await mutationCommit.commitJournalBatch(journalBatch);
      setActiveState(responseId, {
        phase: "journalCommitted",
        journalCommitKind: committed.journalCommitKind,
        buffer,
        documents: [],
      });
      emit("journal_committed", responseId, "journalCommitted", {
        journalCommitKind: committed.journalCommitKind,
      });
      return { ok: true, value: { journalCommitKind: committed.journalCommitKind } };
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
  }

  async function rollbackResponse(responseId: string): Promise<ResponseRollbackResult> {
    const state = responses.get(responseId);
    if (!state) return emptyResponseRollback(responseId);
    if (state.phase === "closed") {
      throw lifecycleError({ responseId, operation: "rollback", state: state.outcome });
    }

    const buffer = state.buffer;
    const docBuffers = [...buffer.docs.values()];
    const pendingDocBuffers = docBuffers.filter((docBuffer) => docBuffer.updates.length > 0);
    const journalCommitKind = journalKindFromState(state);
    emit("rollback", responseId, state.phase, {
      journalCommitKind: journalCommitKind ?? undefined,
    });

    try {
      if (journalCommitKind) {
        await runtimeStore.recoverCommittedResponseProjection(pendingDocBuffers);
        const result = {
          responseId,
          stagedCreates: responseStagedCreateOutcome(buffer, pendingDocBuffers, state),
        };
        transitionClosed(responseId, "rolledBack");
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
        stagedCreates: responseStagedCreateOutcome(buffer, [], state, {
          discardPendingStagedCreates: true,
        }),
      };
      transitionClosed(responseId, "rolledBack");
      return result;
    } catch (cause) {
      await runtimeStore.evictResponseRuntimes(docBuffers, {
        markLiveDocStale: journalCommitKind === "durable",
      });
      transitionClosed(responseId, "rolledBack");
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
    if (state?.phase !== "closed") return;
    throw lifecycleError({
      responseId: input.responseId,
      operation: "stage",
      state: state.outcome,
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
      responses.set(input.responseId, { phase: "buffered", buffer });
      emit("stage", input.responseId, "buffered", { documentId: input.docId });
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
    emit("stage", input.responseId, currentPhase(input.responseId), { documentId: input.docId });
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
      if (state.phase === "closed") continue;
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
          if (docBuffer.createdDocumentBeforeCommit && !journalKindFromState(state)) {
            docBuffer.discardedBeforeCommit = true;
          }
        }
        if (docBuffer.updates.length === 0 && !docBuffer.discardedBeforeCommit) {
          buffer.docs.delete(docId);
        }
      }
      if (!responseBufferHasPendingOutcome(buffer)) {
        if (claimedWriteDropped) {
          transitionClosed(responseId, "rolledBack");
        } else {
          responses.delete(responseId);
          emit("drop_for_thread", responseId, "buffered", { documentId: docId, threadId });
        }
        continue;
      }
      if (droppedClaimedCount > 0) {
        recordClaimedDiscard(buffer, {
          documentId: docId,
          threadId,
          updateCount: droppedClaimedCount,
        });
        emit("drop_for_thread", responseId, currentPhase(responseId), {
          documentId: docId,
          threadId,
          droppedUpdateCount: droppedClaimedCount,
        });
      }
    }
  }

  function activeBuffer(responseId: string): ResponseBuffer | undefined {
    const state = responses.get(responseId);
    return state && state.phase !== "closed" ? state.buffer : undefined;
  }

  function currentPhase(responseId: string): ResponseCommitterPhase {
    const state = responses.get(responseId);
    if (!state) return "buffered";
    return state.phase;
  }

  function journalKindFromState(state: ResponseState): JournalCommitKind | null {
    if (state.phase === "journalCommitted" || state.phase === "liveProjected") {
      return state.journalCommitKind;
    }
    return null;
  }

  function setActiveState(responseId: string, state: ActiveResponseState): void {
    responses.set(responseId, state);
  }

  function transitionClosed(responseId: string, outcome: ResponseLifecycleClosedState): void {
    responses.set(responseId, { phase: "closed", outcome });
    emit("closed", responseId, "closed", { closedOutcome: outcome });
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

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, snapshot, { type: "system" });
  return doc;
}

async function concurrentUpdatesSince(
  coordinator: DocumentCoordinator,
  docId: string,
  doc: Y.Doc,
  baselineDoc: Y.Doc | undefined,
  sinceStateVector: Uint8Array,
  afterJournalId?: number,
  attemptId?: string,
): Promise<ConcurrentUpdate[]> {
  if (coordinator.concurrentUpdatesSince) {
    return coordinator.concurrentUpdatesSince({
      docId,
      doc,
      baselineDoc,
      sinceStateVector,
      afterJournalId,
      attemptId,
    });
  }
  const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
  const probe = baselineDoc ?? new Y.Doc({ gc: false });
  try {
    return effectiveYjsUpdate(probe, update) ? [{ update, origin: { type: "human" } }] : [];
  } finally {
    if (!baselineDoc) probe.destroy();
  }
}

function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

function journalEntries(input: LiveUpdateCommitInput): JournalBatchAppendEntry[] {
  return input.updates.map((entry) => ({
    docId: input.docId,
    update: entry.update,
    meta: entry.meta,
    ...(entry.mutation ? { mutation: entry.mutation } : {}),
  }));
}

function agentUpdateOrigin(turnId: string): ConcurrentUpdateOrigin & { type: "agent" } {
  return { type: "agent", actorTurnId: turnId };
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
  const journalCommitted = state?.phase === "journalCommitted" || state?.phase === "liveProjected";
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
