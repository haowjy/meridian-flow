// Buffers model-response write updates until commit or rollback resolves their lifecycle.
import * as Y from "yjs";

import type { ConcurrentDetectionResult } from "../apply/echo.js";
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, UpdateJournal } from "../ports/update-journal.js";
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
  commitResponse(
    responseId: string,
    options?: ResponseCommitOptions,
  ): Promise<ResponseCommitResult>;
  rollbackResponse(responseId: string): Promise<ResponseRollbackResult>;
  hasBufferedWrites(responseId: string): boolean;
  stagedEntriesForDoc(responseId: string, docId: string): readonly StagedResponseEntry[];
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
  writeId?: string;
  writeOrdinal?: number;
  durableWriteId?: string;
  ensureDocumentBeforeCommit?: boolean;
  createdDocumentBeforeCommit: boolean;
  updateKind?: string;
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

export interface StagedResponseEntry extends JournaledUpdate {
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  writeId: string;
  writeOrdinal: number;
  durableWriteId: string;
}

export interface ResponseCommitOptions {
  destination?: ResponseCommitDestination;
}

export interface ResponseCommitDocumentInput {
  responseId: string;
  docId: string;
  session: ActorSession;
  runtime: RuntimeDocumentState;
  commandName: WriteCommand["command"];
  entries: readonly StagedResponseEntry[];
}

export interface ResponseCommitDestination {
  journal?: Pick<UpdateJournal, "appendBatch">;
  projection?: false | { coordinator: DocumentCoordinator };
  /**
   * Finalizes the response-scoped runtime after the journal/projection commit.
   * Defaults to attaching the committed runtime. `false` explicitly evicts the
   * staged runtime so redirected commits cannot leave draft-only state synced in
   * a live session.
   */
  attachRuntime?: false | ((input: ResponseCommitDocumentInput) => void | Promise<void>);
  recoverCommittedResponseProjection?:
    | false
    | ((documents: readonly ResponseCommitDocumentInput[]) => Promise<void>);
  committedSnapshot?: (input: ResponseCommitDocumentInput) => Uint8Array | undefined;
  persistSyncState?: (input: ResponseCommitDocumentInput) => void | Promise<void>;
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
}

interface ResponseBuffer {
  docs: Map<string, ResponseDocumentBuffer>;
  nextStageSeq: number;
  journalCommitted: boolean;
  commitDestination?: ResponseCommitDestinationIdentity;
}

type ResponseCommitDestinationIdentity = {
  journal: object | "default";
  projection: object | false | "default";
  attachRuntime: object | false | "default";
  recoverCommittedResponseProjection: object | false | "default";
  persistSyncState: object | "default";
};

type ProjectionRecoveryResult = { status: "recovered" } | { status: "not_needed" };

interface ResolvedResponseCommitDestination {
  journal: Pick<UpdateJournal, "appendBatch">;
  projection?: false | { coordinator: DocumentCoordinator };
  attachRuntime(input: ResponseCommitDocumentInput): void | Promise<void>;
  recoverCommittedResponseProjection(
    documents: readonly ResponseCommitDocumentInput[],
  ): Promise<ProjectionRecoveryResult>;
  committedSnapshot(input: ResponseCommitDocumentInput): Uint8Array | undefined;
  persistSyncState(input: ResponseCommitDocumentInput): void | Promise<void>;
  identity: ResponseCommitDestinationIdentity;
}

export function createResponseStaging(deps: {
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  ensureDocument?: (docId: string) => Promise<void>;
  clearKnownContent(docId: string, threadId: string): Promise<void>;
}): ResponseStaging {
  const { runtimeStore, mutationCommit, ensureDocument, clearKnownContent } = deps;
  const responseBuffers = new Map<string, ResponseBuffer>();
  const defaultJournal = {
    appendBatch: (entries: readonly JournalBatchAppendEntry[]) =>
      mutationCommit.commitJournalBatch(entries),
  };

  function responseCommitDestination(
    destination: ResponseCommitDestination = {},
  ): ResolvedResponseCommitDestination {
    const journal = destination.journal ?? defaultJournal;
    const recoverProjection = destination.recoverCommittedResponseProjection;
    return {
      journal,
      projection: destination.projection,
      attachRuntime:
        destination.attachRuntime === false
          ? (input) => runtimeStore.evictRuntime(input.session, input.docId)
          : (destination.attachRuntime ??
            ((input) => runtimeStore.attachRuntime(input.session, input.docId, input.runtime))),
      recoverCommittedResponseProjection:
        recoverProjection === false
          ? async () => ({ status: "not_needed" })
          : async (documents) => {
              const recover =
                recoverProjection ??
                ((inputs: readonly ResponseCommitDocumentInput[]) =>
                  runtimeStore.recoverCommittedResponseProjection(inputs));
              await recover(documents);
              return { status: "recovered" };
            },
      committedSnapshot:
        destination.committedSnapshot ??
        ((input) => runtimeStore.getCommittedSnapshot(input.session, input.docId)),
      persistSyncState: destination.persistSyncState ?? (() => undefined),
      identity: {
        journal: destination.journal ?? "default",
        projection:
          destination.projection === false
            ? false
            : (destination.projection?.coordinator ?? "default"),
        attachRuntime:
          destination.attachRuntime === false ? false : (destination.attachRuntime ?? "default"),
        recoverCommittedResponseProjection:
          recoverProjection === false ? false : (recoverProjection ?? "default"),
        persistSyncState: destination.persistSyncState ?? "default",
      },
    };
  }

  return {
    stageUpdate,
    commitResponse,
    rollbackResponse,
    hasBufferedWrites,
    stagedEntriesForDoc,
    dropForThread,
  };

  async function commitResponse(
    responseId: string,
    options: ResponseCommitOptions = {},
  ): Promise<ResponseCommitResult> {
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
    const destination = responseCommitDestination(options.destination);
    ensureSameCommitDestination(responseId, buffer, destination.identity);
    try {
      if (!buffer.journalCommitted) {
        await mutationCommit.commitJournalBatch(journalBatch, destination);
        buffer.journalCommitted = true;
      }

      for (const docBuffer of docBuffers) {
        if (docBuffer.ensureDocumentBeforeCommit) {
          await ensureDocument?.(docBuffer.docId);
        }
        const afterOwnVector = Y.encodeStateVector(docBuffer.runtime.doc);
        const lastTurnId = docBuffer.updates.at(-1)?.turnId;
        const input = responseCommitDocumentInput(responseId, docBuffer);
        const committedSnapshot = destination.committedSnapshot(input);
        const projected =
          destination.projection === false
            ? noOpProjection()
            : await mutationCommit.projectToLive(
                docBuffer.runtime,
                {
                  docId: docBuffer.docId,
                  commandName: docBuffer.commandName,
                  updates: docBuffer.updates,
                  afterOwnVector,
                  liveOrigin: docBuffer.updates.at(-1)?.liveOrigin ?? { type: "system" },
                  turnId: lastTurnId,
                  committedSnapshot,
                },
                destination.projection,
              );
        if (!projected.ok) throw new Error(projected.response.text);
        await destination.persistSyncState(input);
        await destination.attachRuntime(input);
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
        await Promise.all(
          docBuffers.map((docBuffer) =>
            clearKnownContent(docBuffer.docId, docBuffer.session.threadId),
          ),
        );
        runtimeStore.evictResponseRuntimes(docBuffers);
        throw responseCommitError(responseId, false, cause, null);
      }

      const recovery = await destination
        .recoverCommittedResponseProjection(
          docBuffers.map((docBuffer) => responseCommitDocumentInput(responseId, docBuffer)),
        )
        .catch((error: unknown) => error);
      if (isProjectionRecoveryResult(recovery)) {
        responseBuffers.delete(responseId);
        return responseCommitResult(responseId, buffer, docBuffers, documents);
      }

      runtimeStore.evictResponseRuntimes(docBuffers, { markLiveDocStale: true });
      throw responseCommitError(responseId, true, cause, recovery);
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
        await clearKnownContent(docBuffer.docId, docBuffer.session.threadId);
        if (docBuffer.ensureDocumentBeforeCommit) {
          runtimeStore.evictRuntime(docBuffer.session, docBuffer.docId);
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
      responseBuffers.delete(responseId);
      return {
        responseId,
        stagedCreates: responseStagedCreateOutcome(buffer, [], {
          discardPendingStagedCreates: true,
        }),
      };
    } catch (cause) {
      runtimeStore.evictResponseRuntimes(docBuffers, { markLiveDocStale: buffer.journalCommitted });
      responseBuffers.delete(responseId);
      throw cause;
    }
  }

  function hasBufferedWrites(responseId: string): boolean {
    const buffer = responseBuffers.get(responseId);
    if (!buffer) return false;
    return [...buffer.docs.values()].some((doc) => doc.updates.length > 0);
  }

  function stagedEntriesForDoc(responseId: string, docId: string): readonly StagedResponseEntry[] {
    return responseBuffers.get(responseId)?.docs.get(docId)?.updates.map(cloneStagedEntry) ?? [];
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
            ...(entry.mutation
              ? {
                  mutation: {
                    ...entry.mutation,
                    ...(docBuffer.createdDocumentBeforeCommit
                      ? { createdDocumentBeforeCommit: true }
                      : {}),
                  },
                }
              : {}),
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
          if (docBuffer.createdDocumentBeforeCommit && !buffer.journalCommitted) {
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

function isProjectionRecoveryResult(value: unknown): value is ProjectionRecoveryResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "recovered" || value.status === "not_needed")
  );
}

function ensureSameCommitDestination(
  responseId: string,
  buffer: ResponseBuffer,
  identity: ResponseCommitDestinationIdentity,
): void {
  if (!buffer.commitDestination) {
    buffer.commitDestination = identity;
    return;
  }
  if (sameCommitDestination(buffer.commitDestination, identity)) return;
  throw new ResponseCommitDestinationMismatchError(responseId);
}

function sameCommitDestination(
  left: ResponseCommitDestinationIdentity,
  right: ResponseCommitDestinationIdentity,
): boolean {
  return (
    left.journal === right.journal &&
    left.projection === right.projection &&
    left.attachRuntime === right.attachRuntime &&
    left.recoverCommittedResponseProjection === right.recoverCommittedResponseProjection &&
    left.persistSyncState === right.persistSyncState
  );
}

export class ResponseCommitDestinationMismatchError extends Error {
  constructor(responseId: string) {
    super(
      `Response ${responseId} was already committed to a different destination; retry with the original destination or roll back the response.`,
    );
    this.name = "ResponseCommitDestinationMismatchError";
  }
}

function responseBufferHasPendingOutcome(buffer: ResponseBuffer): boolean {
  return [...buffer.docs.values()].some(
    (docBuffer) => docBuffer.updates.length > 0 || docBuffer.discardedBeforeCommit,
  );
}

function responseCommitDocumentInput(
  responseId: string,
  docBuffer: ResponseDocumentBuffer,
): ResponseCommitDocumentInput {
  return {
    responseId,
    docId: docBuffer.docId,
    session: docBuffer.session,
    runtime: docBuffer.runtime,
    commandName: docBuffer.commandName,
    entries: docBuffer.updates.map(cloneStagedEntry),
  };
}

function cloneStagedEntry(entry: StagedResponseUpdate): StagedResponseEntry {
  return {
    update: entry.update.slice(),
    meta: { ...entry.meta },
    ...(entry.mutation ? { mutation: { ...entry.mutation } } : {}),
    liveOrigin: { ...entry.liveOrigin },
    turnId: entry.turnId,
    writeId: entry.writeId,
    writeOrdinal: entry.writeOrdinal,
    durableWriteId: entry.durableWriteId,
  };
}

function noOpProjection(): { ok: true; concurrent: ConcurrentDetectionResult } {
  return { ok: true, concurrent: { touchedHashes: new Set() } };
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
          docBuffer.createdDocumentBeforeCommit &&
          !buffer.journalCommitted),
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
