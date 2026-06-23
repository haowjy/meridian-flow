// Buffers model-response write updates until commit or rollback resolves their lifecycle.
import * as Y from "yjs";

import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry } from "../ports/update-journal.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { JournaledUpdate, MutationCommit } from "./mutation-commit.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  ResponseCommitResult,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  WriteCommand,
} from "./types.js";

export interface ResponseStaging {
  stageUpdate(input: ResponseStageUpdateInput): void;
  commitResponse(responseId: string): Promise<ResponseCommitResult>;
  rollbackResponse(responseId: string): Promise<ResponseRollbackResult>;
  hasBufferedWrites(responseId: string): boolean;
  hasBufferedWritesForDoc(responseId: string, docId: string): boolean;
  dropForThread(docId: string, threadId: string): void;
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
  ensureDocumentBeforeCommit?: boolean;
}

interface StagedResponseUpdate extends JournaledUpdate {
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
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
  discardedBeforeCommit: boolean;
  baselineUndoStack: string[];
  baselineRedoStack: Array<{ turnId: string; undoUpdateSeq?: number }>;
  baselineRedoStackRehydrated: boolean;
}

interface ResponseBuffer {
  docs: Map<string, ResponseDocumentBuffer>;
  nextStageSeq: number;
  journalCommitted: boolean;
}

export function createResponseStaging(deps: {
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  ensureDocument?: (docId: string) => Promise<void>;
}): ResponseStaging {
  const { runtimeStore, mutationCommit, ensureDocument } = deps;
  const responseBuffers = new Map<string, ResponseBuffer>();

  return {
    stageUpdate,
    commitResponse,
    rollbackResponse,
    hasBufferedWrites,
    hasBufferedWritesForDoc,
    dropForThread,
  };

  async function commitResponse(responseId: string): Promise<ResponseCommitResult> {
    const buffer = responseBuffers.get(responseId);
    if (!buffer) return emptyResponseCommit(responseId);

    const docBuffers = [...buffer.docs.values()].filter(
      (docBuffer) => docBuffer.updates.length > 0,
    );
    if (docBuffers.length === 0) {
      responseBuffers.delete(responseId);
      return emptyResponseCommit(responseId, responseStagedCreateOutcome(buffer, []));
    }
    const journalBatch = responseJournalBatch(docBuffers);
    const documents: ResponseCommitResult["documents"] = [];
    let updateCount = 0;
    try {
      if (!buffer.journalCommitted) {
        await mutationCommit.commitJournalBatch(journalBatch);
        buffer.journalCommitted = true;
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
      responseBuffers.delete(responseId);
      return {
        responseId,
        documentCount: documents.length,
        updateCount,
        documents,
        stagedCreates: responseStagedCreateOutcome(buffer, docBuffers),
      };
    } catch (cause) {
      if (!buffer.journalCommitted) {
        runtimeStore.evictResponseRuntimes(docBuffers);
        throw responseCommitError(responseId, false, cause, null);
      }

      const recoveryFailure = await runtimeStore
        .recoverCommittedResponseProjection(docBuffers)
        .catch((error: unknown) => error);
      if (!recoveryFailure) {
        responseBuffers.delete(responseId);
        return responseCommitResult(responseId, buffer, docBuffers, documents);
      }

      runtimeStore.evictResponseRuntimes(docBuffers, { needsRecovery: true });
      throw responseCommitError(responseId, true, cause, recoveryFailure);
    }
  }

  async function rollbackResponse(responseId: string): Promise<ResponseRollbackResult> {
    const buffer = responseBuffers.get(responseId);
    if (!buffer) return emptyResponseRollback(responseId);

    const docBuffers = [...buffer.docs.values()];
    const pendingDocBuffers = docBuffers.filter((docBuffer) => docBuffer.updates.length > 0);
    try {
      if (buffer.journalCommitted) {
        await runtimeStore.recoverCommittedResponseProjection(pendingDocBuffers);
        responseBuffers.delete(responseId);
        return {
          responseId,
          stagedCreates: responseStagedCreateOutcome(buffer, pendingDocBuffers),
        };
      }

      for (const docBuffer of docBuffers) {
        if (docBuffer.ensureDocumentBeforeCommit) {
          runtimeStore.evictRuntime(docBuffer.session, docBuffer.docId);
          continue;
        }
        docBuffer.runtime.undoStack = [...docBuffer.baselineUndoStack];
        docBuffer.runtime.redoStack = docBuffer.baselineRedoStack.map((entry) => ({ ...entry }));
        docBuffer.runtime.redoStackRehydrated = docBuffer.baselineRedoStackRehydrated;
        const restored = await runtimeStore.restoreRuntimeFromLive(
          docBuffer.session,
          docBuffer.docId,
          docBuffer.runtime,
          docBuffer.commandName,
          { recoverFromJournal: buffer.journalCommitted },
        );
        if (isInternalWriteResult(restored)) throw new Error(restored.text);
        runtimeStore.attachRuntime(docBuffer.session, docBuffer.docId, docBuffer.runtime);
      }
      responseBuffers.delete(responseId);
      return {
        responseId,
        stagedCreates: responseStagedCreateOutcome(buffer, [], {
          discardPendingStagedCreates: true,
        }),
      };
    } catch (cause) {
      runtimeStore.evictResponseRuntimes(docBuffers, { needsRecovery: buffer.journalCommitted });
      responseBuffers.delete(responseId);
      throw cause;
    }
  }

  function hasBufferedWrites(responseId: string): boolean {
    const buffer = responseBuffers.get(responseId);
    if (!buffer) return false;
    return [...buffer.docs.values()].some((doc) => doc.updates.length > 0);
  }

  function hasBufferedWritesForDoc(responseId: string, docId: string): boolean {
    return (responseBuffers.get(responseId)?.docs.get(docId)?.updates.length ?? 0) > 0;
  }

  function stageUpdate(input: ResponseStageUpdateInput): void {
    let buffer = responseBuffers.get(input.responseId);
    if (!buffer) {
      buffer = { docs: new Map(), nextStageSeq: 0, journalCommitted: false };
      responseBuffers.set(input.responseId, buffer);
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
        discardedBeforeCommit: false,
        baselineUndoStack: [...input.runtime.undoStack],
        baselineRedoStack: input.runtime.redoStack.map((entry) => ({ ...entry })),
        baselineRedoStackRehydrated: input.runtime.redoStackRehydrated,
      };
      buffer.docs.set(input.docId, docBuffer);
    }

    docBuffer.commandName = input.commandName;
    docBuffer.ensureDocumentBeforeCommit =
      docBuffer.ensureDocumentBeforeCommit || (input.ensureDocumentBeforeCommit ?? false);
    docBuffer.discardedBeforeCommit = false;
    docBuffer.updates.push({
      update: input.update,
      meta: input.meta,
      mutation: { threadId: input.session.threadId, turnId: input.turnId },
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
    for (const [responseId, buffer] of [...responseBuffers]) {
      const docBuffer = buffer.docs.get(docId);
      if (docBuffer) {
        docBuffer.updates = docBuffer.updates.filter(
          (entry) => entry.mutation?.threadId !== threadId,
        );
        if (docBuffer.session.threadId === threadId) {
          if (docBuffer.ensureDocumentBeforeCommit && !buffer.journalCommitted) {
            docBuffer.discardedBeforeCommit = true;
          }
        }
        if (docBuffer.updates.length === 0 && !docBuffer.discardedBeforeCommit) {
          buffer.docs.delete(docId);
        }
      }
      if (!responseBufferHasPendingOutcome(buffer)) {
        responseBuffers.delete(responseId);
      }
    }
  }
}

function responseBufferHasPendingOutcome(buffer: ResponseBuffer): boolean {
  return [...buffer.docs.values()].some(
    (docBuffer) => docBuffer.updates.length > 0 || docBuffer.discardedBeforeCommit,
  );
}

function responseCommitError(
  responseId: string,
  journalCommitted: boolean,
  cause: unknown,
  recoveryFailure: unknown,
): Error {
  const phase = journalCommitted
    ? "after the journal batch was committed"
    : "before the journal batch was committed";
  const recovery = recoveryFailure
    ? ` Recovery from the committed journal also failed: ${errorMessage(recoveryFailure)}.`
    : journalCommitted
      ? " The affected runtime docs were invalidated and will rebuild from live+journal on next access."
      : " The affected runtime docs were invalidated; the response buffer is still available for retry or rollback.";
  return new Error(
    `Failed to commit response ${responseId} ${phase}: ${errorMessage(cause)}.${recovery}`,
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
          docBuffer.ensureDocumentBeforeCommit &&
          !buffer.journalCommitted),
    ),
  );
  return { committed, discarded };
}

function stagedCreateDocIds(docBuffers: readonly ResponseDocumentBuffer[]): string[] {
  return [
    ...new Set(
      docBuffers
        .filter((docBuffer) => docBuffer.ensureDocumentBeforeCommit)
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
