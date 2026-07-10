// Response committer: explicit response lifecycle states and staged-write buffering.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, JournalCommitKind } from "../ports/update-journal.js";
import { withLiveDocument } from "./coordinator.js";
import { mutationMode, responseInteractionContext } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { JournaledUpdate, MutationCommit, SafetyGateInput } from "./mutation-commit.js";
import {
  bufferedLifecycle,
  closedLifecycle,
  hasCommittedJournalKind,
  type JournalProgressLifecycle,
  journalCommittedLifecycle,
  journalKindFromLifecycle,
  journalStagedLifecycle,
  lifecycleToCommitterPhase,
  liveProjectedLifecycle,
  type MutationLifecycle,
} from "./response-lifecycle.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  ResponseClaimDiscardedEntry,
  ResponseCommitDocumentResult,
  ResponseCommitRejectedResult,
  ResponseCommitResult,
  ResponseCommitSuccessResult,
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
  stageUpdate(input: ResponseStageUpdateInput): InternalWriteResult | null;
  commitResponse(
    responseId: string,
    options?: ResponseCommitOptions,
  ): Promise<ResponseCommitResult>;
  rollbackResponse(
    responseId: string,
    options?: Pick<ResponseCommitOptions, "deferFinalization">,
  ): Promise<ResponseRollbackResult>;
  hasBufferedWrites(responseId: string): boolean;
  bufferedUpdatesForDoc(responseId: string, docId: string): readonly Uint8Array[];
  stagedCreatedDocumentIds(responseId: string, threadId?: string): readonly string[];
  dropForThread(docId: string, threadId: string): void;
}

export interface ResponseCommitOptions {
  signal?: AbortSignal;
  lockTimeoutMs?: number;
  /** Host transaction hook; keeps lifecycle publication aligned with durable commit. */
  deferFinalization?(participant: {
    commit(): void | Promise<void>;
    abort(): void | Promise<void>;
  }): void;
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
  /** Provider-visible tool call id, used when a rejected response voids staged results. */
  toolCallId?: string;
  ensureDocumentBeforeCommit?: boolean;
  createdDocumentBeforeCommit: boolean;
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  /** Runtime state immediately before this staged update was applied. */
  preOwnSnapshot?: Uint8Array;
  interactionContext?: InteractionContext;
}

interface StagedResponseUpdate extends JournaledUpdate {
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  writeId: string;
  writeOrdinal: number;
  durableWriteId: string;
  toolCallId: string;
  stageSeq: number;
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  preOwnSnapshot?: Uint8Array;
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
    { phase: "buffered" | "journalStaged" | "journalCommitted" | "liveProjected" }
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

function captureDeletedBodies(
  snapshot: Uint8Array | undefined,
  affectedHashes: readonly string[],
  model: AgentEditModel,
  codec: AgentEditCodec,
): { hash: string; body: string }[] {
  if (!snapshot) return [];
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, snapshot);
    const affected = new Set(affectedHashes);
    return snapshotBlocks(toDocHandle(doc), model, codec).flatMap((block) => {
      if (!affected.has(block.hash)) return [];
      const separator = block.serialized.indexOf("|");
      return [
        {
          hash: block.hash,
          body: separator < 0 ? block.serialized : block.serialized.slice(separator + 1),
        },
      ];
    });
  } finally {
    doc.destroy();
  }
}

function mergeCapturedBodies(
  preferred: readonly { hash: string; body: string }[],
  fallback: readonly { hash: string; body: string }[],
): { hash: string; body: string }[] {
  return [...new Map([...fallback, ...preferred].map((entry) => [entry.hash, entry])).values()];
}

function bodiesForAffectedHashes(
  bodies: readonly { hash: string; body: string }[],
  affectedHashes: readonly string[],
): { hash: string; body: string }[] {
  const byHash = new Map(bodies.map((entry) => [entry.hash, entry]));
  return affectedHashes.map((hash) => {
    const body = byHash.get(hash);
    return body ?? { hash, body: "body_unavailable" };
  });
}

export function createResponseCommitter(deps: {
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
  ensureDocument?: (docId: string) => Promise<void>;
  onLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onTransition?: (event: ResponseCommitterTransitionDetail) => void;
  closedResponseTombstoneCap?: number;
  afterPreflight?: (responseId: string) => Promise<void> | void;
}): ResponseCommitter {
  const {
    runtimeStore,
    mutationCommit,
    coordinator,
    ensureDocument,
    onClaimDiscarded,
    onTransition,
  } = deps;
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

  function applyDiscardedClaims(buffer: ResponseBuffer, result: ResponseCommitSuccessResult): void {
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

  async function commitResponse(
    responseId: string,
    options: ResponseCommitOptions = {},
  ): Promise<ResponseCommitResult> {
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
    owner.promise = Promise.resolve().then(() => runCommitResponse(responseId, owner, options));
    responses.set(responseId, owner);
    return owner.promise;
  }

  async function runCommitResponse(
    responseId: string,
    owner: CommittingResponseState,
    options: ResponseCommitOptions,
  ): Promise<ResponseCommitResult> {
    const { buffer } = owner;
    const docBuffers = [...buffer.docs.values()]
      .filter((docBuffer) => docBuffer.updates.length > 0)
      .sort((left, right) => left.docId.localeCompare(right.docId));
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(
        responseId,
        responseStagedCreateOutcome(buffer, [], liveResponseState(responseId)),
      );
      finalizeClosed(responseId, owner, "committed", null, bufferThreadId(buffer), options);
      return result;
    }

    const journalBatch = responseJournalBatch(docBuffers);
    let committedLifecycle: JournalProgressLifecycle | null =
      owner.lifecycle.phase === "journalStaged" || hasCommittedJournalKind(owner.lifecycle)
        ? owner.lifecycle
        : null;
    const documents: ResponseCommitDocumentResult[] = [];
    const threadId = bufferThreadId(buffer);
    let retryApplyDocument:
      | ((docBuffer: ResponseDocumentBuffer) => Promise<ResponseCommitDocumentResult>)
      | undefined;
    let recoveryRecheckInputs: ReadonlyMap<string, SafetyGateInput> | null = null;

    try {
      const preflights = new Map<
        string,
        import("./mutation-commit.js").CapturedConcurrentDetection | undefined
      >();
      const rejections: ResponseCommitRejectedResult["rejections"] = [];
      for (const docBuffer of docBuffers) {
        const hashes = responseHashes(docBuffer);
        const afterOwnVector = Y.encodeStateVector(docBuffer.runtime.doc);
        const lastTurnId = docBuffer.updates.at(-1)?.turnId;
        const gate = await withLiveDocument(
          coordinator,
          docBuffer.docId,
          docBuffer.commandName,
          docBuffer.docId,
          (liveDoc) =>
            mutationCommit.preflightSafetyGate(liveDoc, {
              docId: docBuffer.docId,
              runtime: docBuffer.runtime,
              afterOwnVector,
              deletedHashes: hashes.deletedHashes,
              preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot,
              interactionContext: docBuffer.interactionContext,
              ownTurnId: lastTurnId,
            }),
          { signal: options.signal, timeoutMs: options.lockTimeoutMs ?? 30_000 },
        );
        if (isInternalWriteResult(gate)) {
          if (gate.status === "document_not_found" && docBuffer.createdDocumentBeforeCommit) {
            preflights.set(docBuffer.docId, undefined);
            continue;
          }
          throw new Error(gate.text);
        }
        if (!gate) throw new Error(`Preflight returned no result for ${docBuffer.docId}.`);
        if (gate.verdict === "reject") {
          rejections.push({
            documentId: docBuffer.docId,
            conflictedBlockHashes: gate.conflictedBlockHashes,
            affectedWriteIds: affectedWriteIds(docBuffer, gate.conflictedBlockHashes),
          });
        } else {
          preflights.set(docBuffer.docId, gate.concurrent);
        }
      }

      if (rejections.length > 0) {
        const rejectionByDocument = new Map(
          rejections.map((rejection) => [rejection.documentId, rejection] as const),
        );
        const responseRejections = docBuffers.map(
          (docBuffer): ResponseCommitRejectedResult["rejections"][number] =>
            rejectionByDocument.get(docBuffer.docId) ?? {
              documentId: docBuffer.docId,
              conflictedBlockHashes: [],
              affectedWriteIds: [],
            },
        );
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, bufferedLifecycle(), { ...(threadId ? { threadId } : {}) });
        finalizeClosed(responseId, owner, "rejected", null, threadId, options);
        return { status: "rejected", responseId, rejections: responseRejections };
      }

      await deps.afterPreflight?.(responseId);
      options.signal?.throwIfAborted();
      if (!committedLifecycle) {
        const journalCommitKind = await transitionJournal(responseId, owner, journalBatch);
        committedLifecycle = lifecycleForJournalKind(journalCommitKind);
      }

      const journalCommitKind = committedLifecycle.journalCommitKind;
      // Capture the inputs independently of the mutable response buffers before
      // phase C. Last-resort recovery must not depend on state damaged by the
      // projection failure it is diagnosing.
      recoveryRecheckInputs = new Map(
        docBuffers.map((docBuffer) => {
          const hashes = responseHashes(docBuffer);
          return [
            docBuffer.docId,
            {
              docId: docBuffer.docId,
              runtime: docBuffer.runtime,
              afterOwnVector: Y.encodeStateVector(docBuffer.runtime.doc),
              deletedHashes: new Set(hashes.deletedHashes),
              preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot,
              interactionContext: docBuffer.interactionContext,
              ownTurnId: docBuffer.updates.at(-1)?.turnId,
            },
          ] satisfies [string, SafetyGateInput];
        }),
      );
      const applyDocument = async (
        docBuffer: ResponseDocumentBuffer,
        lockOptions?: { signal?: AbortSignal; timeoutMs?: number },
      ): Promise<ResponseCommitDocumentResult> => {
        if (docBuffer.ensureDocumentBeforeCommit) {
          await ensureDocument?.(docBuffer.docId);
        }
        const afterOwnVector = Y.encodeStateVector(docBuffer.runtime.doc);
        const lastTurnId = docBuffer.updates.at(-1)?.turnId;
        const hashes = responseHashes(docBuffer);
        const applied = await withLiveDocument(
          coordinator,
          docBuffer.docId,
          docBuffer.commandName,
          docBuffer.docId,
          (liveDoc) =>
            mutationCommit.applyCommittedUpdateWithRecheck(
              liveDoc,
              {
                docId: docBuffer.docId,
                runtime: docBuffer.runtime,
                afterOwnVector,
                deletedHashes: hashes.deletedHashes,
                preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot,
                interactionContext: docBuffer.interactionContext,
                ownTurnId: lastTurnId,
                update: mergeStagedUpdates(docBuffer),
                liveOrigin: docBuffer.updates.at(-1)?.liveOrigin ?? { type: "system" },
              },
              preflights.get(docBuffer.docId),
            ),
          lockOptions,
        );
        if (isInternalWriteResult(applied)) throw new Error(applied.text);
        if (!applied) throw new Error(`Live apply returned no result for ${docBuffer.docId}.`);
        for (const concurrent of applied.concurrent.updates) {
          if (concurrent.update.length > 0) {
            Y.applyUpdate(docBuffer.runtime.doc, concurrent.update, concurrent.origin);
          }
        }
        runtimeStore.attachRuntime(docBuffer.session, docBuffer.docId, docBuffer.runtime);
        return {
          documentId: docBuffer.docId,
          updateCount: docBuffer.updates.length,
          ...(applied.concurrent.detection.info
            ? { concurrentEdits: applied.concurrent.detection.info }
            : {}),
          ...(applied.lateSweep
            ? {
                lateSweep: {
                  ...applied.lateSweep,
                  capturedDeletedBodies: bodiesForAffectedHashes(
                    mergeCapturedBodies(
                      applied.lateSweep.capturedDeletedBodies ?? [],
                      mergeCapturedBodies(
                        captureDeletedBodies(
                          applied.concurrent.detectionSnapshot,
                          applied.lateSweep.affectedBlockHashes,
                          deps.model,
                          deps.codec,
                        ),
                        captureDeletedBodies(
                          docBuffer.updates[0]?.preOwnSnapshot,
                          applied.lateSweep.affectedBlockHashes,
                          deps.model,
                          deps.codec,
                        ),
                      ),
                    ),
                    applied.lateSweep.affectedBlockHashes,
                  ),
                },
              }
            : {}),
        };
      };
      retryApplyDocument = (docBuffer) => applyDocument(docBuffer);

      for (const docBuffer of docBuffers) {
        const document = await applyDocument(docBuffer, {
          signal: options.signal,
          timeoutMs: options.lockTimeoutMs ?? 30_000,
        });
        documents.push(document);
        const partialLifecycle = lifecycleForJournalKind(journalCommitKind);
        assertOwner(responseId, owner);
        owner.lifecycle = partialLifecycle;
        owner.documents = [...documents];
        emit("live_projected", responseId, partialLifecycle, {
          journalCommitKind,
          documentId: docBuffer.docId,
          ...(threadId ? { threadId } : {}),
        });
      }

      const finalLifecycle =
        committedLifecycle.phase === "journalStaged"
          ? journalStagedLifecycle()
          : liveProjectedLifecycle("durable");
      assertOwner(responseId, owner);
      owner.lifecycle = finalLifecycle;
      owner.documents = documents;
      emit("live_projected", responseId, finalLifecycle, {
        journalCommitKind,
        ...(threadId ? { threadId } : {}),
      });

      const result: ResponseCommitSuccessResult = {
        status: "committed",
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
      fenceLateSweeps(docBuffers, result.documents);
      applyDiscardedClaims(buffer, result);
      finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
      return result;
    } catch (cause) {
      if (!committedLifecycle) {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, bufferedLifecycle(), { ...(threadId ? { threadId } : {}) });
        assertOwner(responseId, owner);
        responses.set(responseId, {
          ownership: "buffered",
          lifecycle: { phase: "buffered" },
          buffer,
        });
        throw responseCommitError(responseId, null, cause, null);
      }
      if (committedLifecycle.phase === "journalStaged") {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, journalStagedLifecycle(), {
          journalCommitKind: "staged",
          ...(threadId ? { threadId } : {}),
        });
        assertOwner(responseId, owner);
        responses.set(responseId, {
          ownership: "buffered",
          lifecycle: { phase: "buffered" },
          buffer,
        });
        throw responseCommitError(responseId, "staged", cause, null);
      }

      const journalCommitKind = committedLifecycle.journalCommitKind;

      // Phase B is durable, so a transient phase-C coordinator/lock failure cannot
      // turn the response into blind journal replay. Retry the same recheck+apply
      // under a fresh lock first, preserving late-sweep reporting.
      try {
        for (const docBuffer of docBuffers.slice(documents.length)) {
          if (!retryApplyDocument) throw new Error("Phase-C retry was not initialized.");
          documents.push(await retryApplyDocument(docBuffer));
        }
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
        fenceLateSweeps(docBuffers, result.documents);
        applyDiscardedClaims(buffer, result);
        finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
        return result;
      } catch {
        // Persistent failures retain the existing last-resort journal recovery.
      }

      const recoveryBodies = recoveryRecheckInputs
        ? await captureRecoveryBodies(docBuffers, recoveryRecheckInputs).catch(() => null)
        : null;
      const recoveryFailure = await runtimeStore
        .recoverCommittedResponseProjection(docBuffers)
        .catch((error: unknown) => error);
      if (!recoveryFailure) {
        emit("recovery_succeeded", responseId, journalCommittedLifecycle(journalCommitKind), {
          journalCommitKind,
          ...(threadId ? { threadId } : {}),
        });
        const recheckedDocuments = recoveryRecheckInputs
          ? await recheckRecoveredDocuments(
              docBuffers,
              documents,
              recoveryRecheckInputs,
              recoveryBodies,
            ).catch(() => null)
          : null;
        // A positive recheck can report the concrete sweep. A negative result
        // after journal replay cannot restore the exact pre-recovery live view,
        // so last-resort recovery must still disclose degraded awareness.
        const awarenessDegraded =
          recheckedDocuments === null ||
          !recheckedDocuments.some((document) => document.lateSweep !== undefined);
        if (awarenessDegraded) {
          const committedDocumentIds = docBuffers.map((docBuffer) => docBuffer.docId);
          for (const sessionId of new Set(docBuffers.map((docBuffer) => docBuffer.session.id))) {
            runtimeStore.setReadRequiredFence(sessionId, committedDocumentIds);
          }
        }
        const result = responseCommitResult(
          responseId,
          buffer,
          docBuffers,
          recheckedDocuments ?? documents,
          liveResponseState(responseId),
          awarenessDegraded ? { awarenessDegraded: true } : {},
        );
        fenceLateSweeps(docBuffers, result.documents);
        assertRecoveryResultHonest(result, journalCommitKind);
        applyDiscardedClaims(buffer, result);
        finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
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
      finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
      throw responseCommitError(responseId, journalCommitKind, cause, recoveryFailure);
    }
  }

  async function recheckRecoveredDocuments(
    docBuffers: readonly ResponseDocumentBuffer[],
    knownDocuments: readonly ResponseCommitDocumentResult[],
    inputs: ReadonlyMap<string, SafetyGateInput>,
    recoveryBodies: ReadonlyMap<string, readonly { hash: string; body: string }[]> | null,
  ): Promise<ResponseCommitDocumentResult[]> {
    if (!recoveryBodies) throw new Error("Recovery body capture was unavailable.");
    const documentsById = new Map(
      knownDocuments.map((document) => [document.documentId, document]),
    );
    for (const docBuffer of docBuffers) {
      const input = inputs.get(docBuffer.docId);
      if (!input) throw new Error(`Recovery recheck input missing for ${docBuffer.docId}.`);
      const rechecked = await withLiveDocument(
        coordinator,
        docBuffer.docId,
        docBuffer.commandName,
        docBuffer.docId,
        (liveDoc) => mutationCommit.recheckCommittedUpdate(liveDoc, input),
      );
      if (isInternalWriteResult(rechecked) || !rechecked) {
        throw new Error(`Recovery recheck unavailable for ${docBuffer.docId}.`);
      }
      const current = documentsById.get(docBuffer.docId) ?? {
        documentId: docBuffer.docId,
        updateCount: docBuffer.updates.length,
      };
      documentsById.set(docBuffer.docId, {
        ...current,
        ...(rechecked.concurrent.detection.info
          ? { concurrentEdits: rechecked.concurrent.detection.info }
          : {}),
        ...(rechecked.lateSweep
          ? {
              lateSweep: {
                ...rechecked.lateSweep,
                capturedDeletedBodies: bodiesForAffectedHashes(
                  recoveryBodies.get(docBuffer.docId) ?? [],
                  rechecked.lateSweep.affectedBlockHashes,
                ),
              },
            }
          : {}),
      });
    }
    return docBuffers.map((docBuffer) => {
      const document = documentsById.get(docBuffer.docId);
      if (!document) throw new Error(`Recovery result missing for ${docBuffer.docId}.`);
      return document;
    });
  }

  function fenceLateSweeps(
    docBuffers: readonly ResponseDocumentBuffer[],
    documents: readonly ResponseCommitDocumentResult[],
  ): void {
    const swept = new Set(
      documents.filter((document) => document.lateSweep).map((document) => document.documentId),
    );
    for (const docBuffer of docBuffers) {
      if (swept.has(docBuffer.docId)) {
        runtimeStore.setReadRequiredFence(docBuffer.session.id, [docBuffer.docId]);
      }
    }
  }

  async function captureRecoveryBodies(
    docBuffers: readonly ResponseDocumentBuffer[],
    inputs: ReadonlyMap<string, SafetyGateInput>,
  ): Promise<ReadonlyMap<string, readonly { hash: string; body: string }[]>> {
    const bodies = new Map<string, readonly { hash: string; body: string }[]>();
    for (const docBuffer of docBuffers) {
      const input = inputs.get(docBuffer.docId);
      if (!input) throw new Error(`Recovery recheck input missing for ${docBuffer.docId}.`);
      const captured = await withLiveDocument(
        coordinator,
        docBuffer.docId,
        docBuffer.commandName,
        docBuffer.docId,
        (liveDoc) =>
          captureDeletedBodies(
            Y.encodeStateAsUpdate(liveDoc),
            [...input.deletedHashes],
            deps.model,
            deps.codec,
          ),
      );
      if (isInternalWriteResult(captured) || !captured) {
        throw new Error(`Recovery body capture unavailable for ${docBuffer.docId}.`);
      }
      const fallback = captureDeletedBodies(
        input.preOwnSnapshot,
        [...input.deletedHashes],
        deps.model,
        deps.codec,
      );
      bodies.set(docBuffer.docId, mergeCapturedBodies(captured, fallback));
    }
    return bodies;
  }

  async function transitionJournal(
    responseId: string,
    owner: CommittingResponseState,
    journalBatch: JournalBatchAppendEntry[],
  ): Promise<JournalCommitKind> {
    const threadId = bufferThreadId(owner.buffer);
    const committed = await mutationCommit.commitJournalBatch(journalBatch);
    return committed.journalCommitKind === "staged"
      ? transitionJournalStaged(responseId, owner, threadId)
      : transitionJournalCommitted(responseId, owner, threadId);
  }

  function transitionJournalStaged(
    responseId: string,
    owner: CommittingResponseState,
    threadId?: string,
  ): JournalCommitKind {
    const lifecycle = journalStagedLifecycle();
    assertOwner(responseId, owner);
    owner.lifecycle = lifecycle;
    emit("journal_staged", responseId, lifecycle, {
      journalCommitKind: "staged",
      ...(threadId ? { threadId } : {}),
    });
    return "staged";
  }

  function transitionJournalCommitted(
    responseId: string,
    owner: CommittingResponseState,
    threadId?: string,
  ): JournalCommitKind {
    const lifecycle = journalCommittedLifecycle("durable");
    assertOwner(responseId, owner);
    owner.lifecycle = lifecycle;
    emit("journal_committed", responseId, lifecycle, {
      journalCommitKind: "durable",
      ...(threadId ? { threadId } : {}),
    });
    return "durable";
  }

  async function rollbackResponse(
    responseId: string,
    options: Pick<ResponseCommitOptions, "deferFinalization"> = {},
  ): Promise<ResponseRollbackResult> {
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
          status: "rolledBack" as const,
          responseId,
          stagedCreates: responseStagedCreateOutcome(
            buffer,
            pendingDocBuffers,
            liveResponseState(responseId),
          ),
        };
        finalizeRollbackClosed(responseId, state, journalCommitKind, threadId, options);
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
        status: "rolledBack" as const,
        responseId,
        stagedCreates: responseStagedCreateOutcome(buffer, [], liveResponseState(responseId), {
          discardPendingStagedCreates: true,
        }),
      };
      finalizeRollbackClosed(responseId, state, null, threadId, options);
      return result;
    } catch {
      await runtimeStore.evictResponseRuntimes(docBuffers, {
        markLiveDocStale: journalCommitKind === "durable",
      });
      finalizeRollbackClosed(responseId, state, journalCommitKind, threadId, options);
      return {
        status: "rolledBackDegraded",
        responseId,
        stagedCreates: responseStagedCreateOutcome(buffer, [], liveResponseState(responseId), {
          discardPendingStagedCreates: true,
        }),
        restorationFailed: true,
      };
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

  function stageUpdate(input: ResponseStageUpdateInput): InternalWriteResult | null {
    if (runtimeStore.isReadFenced(input.session.id, input.docId)) {
      return readRequiredRejection(input.docId);
    }
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
        ...mutationMode(interactionContext),
      },
      writeId: input.writeId ?? "w0",
      writeOrdinal: input.writeOrdinal ?? 0,
      durableWriteId:
        input.durableWriteId ?? `${input.session.threadId}:${input.turnId}:${buffer.nextStageSeq}`,
      toolCallId: input.toolCallId ?? input.writeId ?? input.durableWriteId ?? "unknown-tool-call",
      liveOrigin: input.liveOrigin,
      turnId: input.turnId,
      stageSeq: buffer.nextStageSeq,
      touchedHashes: new Set(input.touchedHashes),
      deletedHashes: new Set(input.deletedHashes),
      ...(input.preOwnSnapshot ? { preOwnSnapshot: input.preOwnSnapshot } : {}),
    });
    buffer.nextStageSeq += 1;
    const stagedState = responses.get(input.responseId);
    if (stagedState?.ownership === "buffered") {
      emit("stage", input.responseId, stagedState.lifecycle, {
        documentId: input.docId,
        threadId: input.session.threadId,
      });
    }
    return null;
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

  function finalizeClosed(
    responseId: string,
    owner: CommittingResponseState,
    closed: ResponseLifecycleClosedState,
    journalCommitKind: JournalCommitKind | null,
    threadId: string | undefined,
    options: ResponseCommitOptions,
  ): void {
    if (!options.deferFinalization) {
      transitionClosed(responseId, owner, closed, journalCommitKind, threadId);
      return;
    }
    let settled = false;
    options.deferFinalization({
      commit() {
        if (settled) return;
        settled = true;
        transitionClosed(responseId, owner, closed, journalCommitKind, threadId);
      },
      abort() {
        if (settled) return;
        settled = true;
        if (responses.get(responseId) !== owner) return;
        responses.set(responseId, {
          ownership: "buffered",
          lifecycle: { phase: "buffered" },
          buffer: owner.buffer,
        });
      },
    });
  }

  function finalizeRollbackClosed(
    responseId: string,
    owner: BufferedResponseState,
    journalCommitKind: JournalCommitKind | null,
    threadId: string | undefined,
    options: Pick<ResponseCommitOptions, "deferFinalization">,
  ): void {
    if (!options.deferFinalization) {
      transitionClosed(responseId, owner, "rolledBack", journalCommitKind, threadId);
      return;
    }
    let settled = false;
    options.deferFinalization({
      commit() {
        if (settled) return;
        settled = true;
        transitionClosed(responseId, owner, "rolledBack", journalCommitKind, threadId);
      },
      abort() {
        settled = true;
      },
    });
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

function readRequiredRejection(docId: string): InternalWriteResult {
  return {
    status: "rejected_response_requires_reread",
    text: `status: rejected_response_requires_reread\n\nThis document must be read after a rejected response before it can be changed. Run write(command="read", file="${docId}") and retry.`,
  };
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
        .filter(([, docBuffer]) => docBuffer.updates.length > 0 || docBuffer.discardedBeforeCommit)
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
      : journalCommitKind === "staged"
        ? "after only a staged journal batch was accepted"
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

function lifecycleForJournalKind(journalCommitKind: JournalCommitKind): JournalProgressLifecycle {
  return journalCommitKind === "staged"
    ? journalStagedLifecycle()
    : journalCommittedLifecycle("durable");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyResponseCommit(
  responseId: string,
  stagedCreates: ResponseStagedCreateOutcome = { committed: [], discarded: [] },
): ResponseCommitSuccessResult {
  return {
    status: "committed",
    responseId,
    documentCount: 0,
    updateCount: 0,
    documents: [],
    stagedCreates,
  };
}

function emptyResponseRollback(responseId: string): ResponseRollbackResult {
  return { status: "rolledBack", responseId, stagedCreates: { committed: [], discarded: [] } };
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
  knownDocuments: readonly ResponseCommitDocumentResult[] = [],
  state: ResponseState | undefined,
  flags: Pick<ResponseCommitSuccessResult, "awarenessDegraded"> = {},
): ResponseCommitSuccessResult {
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
    status: "committed",
    responseId,
    documentCount: documentsById.size,
    updateCount: docBuffers.reduce((total, docBuffer) => total + docBuffer.updates.length, 0),
    documents: [...documentsById.values()],
    stagedCreates: responseStagedCreateOutcome(buffer, docBuffers, state),
    ...flags,
  };
}

function assertRecoveryResultHonest(
  result: ResponseCommitSuccessResult,
  journalCommitKind: JournalCommitKind,
): void {
  if (journalCommitKind !== "durable") return;
  const reportedSweep = result.documents.some((document) => document.lateSweep !== undefined);
  if (!reportedSweep && result.awarenessDegraded !== true) {
    throw new Error(
      "Invariant violation: durable recovery returned committed without a late sweep or degraded-awareness report.",
    );
  }
}

function responseHashes(docBuffer: ResponseDocumentBuffer): {
  touchedHashes: Set<string>;
  deletedHashes: Set<string>;
} {
  const touchedHashes = new Set<string>();
  const deletedHashes = new Set<string>();
  for (const update of docBuffer.updates) {
    for (const hash of update.touchedHashes) touchedHashes.add(hash);
    for (const hash of update.deletedHashes) deletedHashes.add(hash);
  }
  return { touchedHashes, deletedHashes };
}

function affectedWriteIds(
  docBuffer: ResponseDocumentBuffer,
  conflictedBlockHashes: readonly string[],
): string[] {
  const conflicts = new Set(conflictedBlockHashes);
  return docBuffer.updates
    .filter((update) =>
      [...update.touchedHashes, ...update.deletedHashes].some((hash) => conflicts.has(hash)),
    )
    .map((update) => update.toolCallId);
}

function mergeStagedUpdates(docBuffer: ResponseDocumentBuffer): Uint8Array {
  const updates = docBuffer.updates.map((entry) => entry.update);
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}
