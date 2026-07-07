// Buffers model-response write updates until commit or rollback resolves their lifecycle.
import * as Y from "yjs";

import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, JournalCommitKind } from "../ports/update-journal.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { JournaledUpdate, MutationCommit } from "./mutation-commit.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  ResponseCommitResult,
  ResponseLifecycleClosedState,
  ResponseLifecycleErrorDetail,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  WriteCommand,
} from "./types.js";

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
  // Per-doc buffers lose insertion order across documents; commit derives the
  // journal batch by this response-local staging sequence.
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
  journalCommitKind: JournalCommitKind | null;
}

type ResponseState =
  | { status: "open"; buffer: ResponseBuffer }
  | { status: ResponseLifecycleClosedState };

export class ResponseLifecycleError extends Error {
  constructor(readonly detail: ResponseLifecycleErrorDetail) {
    super(responseLifecycleMessage(detail));
    this.name = "ResponseLifecycleError";
  }
}

export function isResponseLifecycleError(error: unknown): error is ResponseLifecycleError {
  return error instanceof ResponseLifecycleError;
}

export function createResponseStaging(deps: {
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  ensureDocument?: (docId: string) => Promise<void>;
  onLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
}): ResponseStaging {
  const { runtimeStore, mutationCommit, ensureDocument } = deps;
  const responses = new Map<string, ResponseState>();

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
    if (state.status !== "open") {
      throw lifecycleError({ responseId, operation: "commit", state: state.status });
    }
    const buffer = state.buffer;

    const docBuffers = [...buffer.docs.values()].filter(
      (docBuffer) => docBuffer.updates.length > 0,
    );
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(responseId, responseStagedCreateOutcome(buffer, []));
      closeResponse(responseId, "committed");
      return result;
    }
    const journalBatch = responseJournalBatch(docBuffers);
    const documents: ResponseCommitResult["documents"] = [];
    let updateCount = 0;
    try {
      if (!buffer.journalCommitKind) {
        const committed = await mutationCommit.commitJournalBatch(journalBatch);
        buffer.journalCommitKind = committed.journalCommitKind;
      }

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
        updateCount += docBuffer.updates.length;
        documents.push({
          documentId: docBuffer.docId,
          updateCount: docBuffer.updates.length,
          ...(projected.concurrent.info ? { concurrentEdits: projected.concurrent.info } : {}),
        });
      }
      const result = {
        responseId,
        documentCount: documents.length,
        updateCount,
        documents,
        stagedCreates: responseStagedCreateOutcome(buffer, docBuffers),
      };
      closeResponse(responseId, "committed");
      return result;
    } catch (cause) {
      if (!buffer.journalCommitKind) {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        throw responseCommitError(responseId, null, cause, null);
      }
      if (buffer.journalCommitKind === "syntheticPending") {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        throw responseCommitError(responseId, buffer.journalCommitKind, cause, null);
      }

      const recoveryFailure = await runtimeStore
        .recoverCommittedResponseProjection(docBuffers)
        .catch((error: unknown) => error);
      if (!recoveryFailure) {
        const result = responseCommitResult(responseId, buffer, docBuffers, documents);
        closeResponse(responseId, "committed");
        return result;
      }

      await runtimeStore.evictResponseRuntimes(docBuffers, { markLiveDocStale: true });
      throw responseCommitError(responseId, buffer.journalCommitKind, cause, recoveryFailure);
    }
  }

  async function rollbackResponse(responseId: string): Promise<ResponseRollbackResult> {
    const state = responses.get(responseId);
    if (!state) return emptyResponseRollback(responseId);
    if (state.status !== "open") {
      throw lifecycleError({ responseId, operation: "rollback", state: state.status });
    }
    const buffer = state.buffer;

    const docBuffers = [...buffer.docs.values()];
    const pendingDocBuffers = docBuffers.filter((docBuffer) => docBuffer.updates.length > 0);
    try {
      if (buffer.journalCommitKind) {
        await runtimeStore.recoverCommittedResponseProjection(pendingDocBuffers);
        const result = {
          responseId,
          stagedCreates: responseStagedCreateOutcome(buffer, pendingDocBuffers),
        };
        closeResponse(responseId, "rolledBack");
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
        stagedCreates: responseStagedCreateOutcome(buffer, [], {
          discardPendingStagedCreates: true,
        }),
      };
      closeResponse(responseId, "rolledBack");
      return result;
    } catch (cause) {
      await runtimeStore.evictResponseRuntimes(docBuffers, {
        markLiveDocStale: buffer.journalCommitKind === "durable",
      });
      closeResponse(responseId, "rolledBack");
      throw cause;
    }
  }

  function hasBufferedWrites(responseId: string): boolean {
    const buffer = openBuffer(responseId);
    if (!buffer) return false;
    return [...buffer.docs.values()].some((doc) => doc.updates.length > 0);
  }

  function bufferedUpdatesForDoc(responseId: string, docId: string): readonly Uint8Array[] {
    return (
      openBuffer(responseId)
        ?.docs.get(docId)
        ?.updates.map((entry) => entry.update) ?? []
    );
  }

  function stagedCreatedDocumentIds(responseId: string, threadId?: string): readonly string[] {
    const buffer = openBuffer(responseId);
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
    if (state?.status !== "committed" && state?.status !== "rolledBack") return;
    throw lifecycleError({
      responseId: input.responseId,
      operation: "stage",
      state: state.status,
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
    let buffer = openBuffer(input.responseId);
    if (!buffer) {
      buffer = { docs: new Map(), nextStageSeq: 0, journalCommitKind: null };
      responses.set(input.responseId, { status: "open", buffer });
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
      if (state.status !== "open") continue;
      const buffer = state.buffer;
      const docBuffer = buffer.docs.get(docId);
      let claimedWriteDropped = false;
      if (docBuffer) {
        claimedWriteDropped = docBuffer.updates.some(
          (entry) => entry.mutation?.threadId === threadId,
        );
        docBuffer.updates = docBuffer.updates.filter(
          (entry) => entry.mutation?.threadId !== threadId,
        );
        if (docBuffer.session.threadId === threadId) {
          if (docBuffer.createdDocumentBeforeCommit && !buffer.journalCommitKind) {
            docBuffer.discardedBeforeCommit = true;
          }
        }
        if (docBuffer.updates.length === 0 && !docBuffer.discardedBeforeCommit) {
          buffer.docs.delete(docId);
        }
      }
      if (!responseBufferHasPendingOutcome(buffer)) {
        if (claimedWriteDropped) {
          closeResponse(responseId, "rolledBack");
        } else {
          responses.delete(responseId);
        }
      }
    }
  }

  function openBuffer(responseId: string): ResponseBuffer | undefined {
    const state = responses.get(responseId);
    return state?.status === "open" ? state.buffer : undefined;
  }

  function closeResponse(responseId: string, status: ResponseLifecycleClosedState): void {
    responses.set(responseId, { status });
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

function responseInteractionContext(
  docBuffer: ResponseDocumentBuffer,
  inputContext: InteractionContext | undefined,
): InteractionContext | undefined {
  if (docBuffer.interactionContext?.mode === "threadPeer" && inputContext?.mode !== "threadPeer") {
    return docBuffer.interactionContext;
  }
  return inputContext ?? docBuffer.interactionContext;
}

function mutationMode(
  context: InteractionContext | undefined,
): { mode: "threadPeer"; branchGeneration: number } | { mode: "live" } {
  return context?.mode === "threadPeer"
    ? { mode: "threadPeer", branchGeneration: context.branchGeneration }
    : { mode: "live" };
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
  options: { discardPendingStagedCreates?: boolean } = {},
): ResponseStagedCreateOutcome {
  const committed = stagedCreateDocIds(committedDocBuffers);
  const discarded = stagedCreateDocIds(
    [...buffer.docs.values()].filter(
      (docBuffer) =>
        docBuffer.discardedBeforeCommit ||
        (options.discardPendingStagedCreates &&
          docBuffer.createdDocumentBeforeCommit &&
          !buffer.journalCommitKind),
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
  knownDocuments: ResponseCommitResult["documents"] = [],
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
    stagedCreates: responseStagedCreateOutcome(buffer, docBuffers),
  };
}
