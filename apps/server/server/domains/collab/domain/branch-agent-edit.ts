/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentEditCodec,
  bytesEqual,
  cloneYDoc,
  type DocumentCoordinator,
  DocumentNotFoundError,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalReadOptions,
  type JournalSnapshot,
  type PersistedUpdate,
  type ReversalStore,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchCoordinator, BranchSnapshot } from "./branch-coordinator.js";
import type { WorkDraftLookup } from "./branch-pulls.js";
import {
  type AutoBranchPushPort,
  type BranchJournalRow,
  branchUpdateMetaWithReplacementScopes,
} from "./branch-push-contracts.js";
import { type BranchResolver, isBranchNotFoundError } from "./branch-resolver.js";
import {
  type BranchReversalScope,
  type BranchReversalState,
  branchRowAsPersistedUpdate,
  buildBranchReversalState,
  groupedOrdinalKey,
  materializeSnapshot,
  resolveBranchReversalScope,
  serializeBranchReversalRecord,
  stageBranchReversal,
} from "./branch-reversal-history.js";
import {
  docFromState,
  partitionByBlockCoverage,
  touchedHashesForCoverage,
} from "./branch-update-attribution.js";
import { enlistResponseParticipant } from "./response-transaction.js";

export { activeBranchAgentWriteRows } from "./branch-reversal-history.js";

export type BranchConcurrentJournalWatermarks = {
  current(threadId: ThreadId, documentId: DocumentId): number | undefined;
  capturePending(
    threadId: ThreadId,
    documentId: DocumentId,
    journalId: number,
    attemptId?: string,
  ): void;
  commitPending(threadId: ThreadId, documentId: DocumentId, attemptId?: string): void;
  clearPending(threadId: ThreadId, documentId: DocumentId): void;
};

export function createBranchConcurrentJournalWatermarks(): BranchConcurrentJournalWatermarks {
  const currentByThreadDocument = new Map<string, number>();
  const pendingByThreadDocument = new Map<string, { journalId: number; attemptId?: string }>();
  const key = (threadId: ThreadId, documentId: DocumentId) => `${threadId}:${documentId}`;
  return {
    current(threadId, documentId) {
      return currentByThreadDocument.get(key(threadId, documentId));
    },
    capturePending(threadId, documentId, journalId, attemptId) {
      pendingByThreadDocument.set(key(threadId, documentId), { journalId, attemptId });
    },
    commitPending(threadId, documentId, attemptId) {
      const mapKey = key(threadId, documentId);
      const pending = pendingByThreadDocument.get(mapKey);
      if (pending === undefined) return;
      if (pending.attemptId !== attemptId) return;
      const current = currentByThreadDocument.get(mapKey) ?? 0;
      if (pending.journalId > current) currentByThreadDocument.set(mapKey, pending.journalId);
      pendingByThreadDocument.delete(mapKey);
    },
    clearPending(threadId, documentId) {
      pendingByThreadDocument.delete(key(threadId, documentId));
    },
  };
}

type ConcurrentUpdateOrigin =
  | { type: "human"; userId: string }
  | { type: "agent"; actorTurnId: string };

type ConcurrentAttributionBasis = {
  baselineState: Uint8Array | null;
  currentUpstreamState?: Uint8Array;
  fallbackCurrentUpstream: Y.Doc;
  journalRows: readonly BranchJournalRow[];
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
};

type PartitionedConcurrentUpdate =
  | {
      type: "journal";
      rowId: number;
      origin: ConcurrentUpdateOrigin;
      effectiveUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      deletedHashes?: { human?: readonly string[]; agent?: readonly string[] };
    }
  | {
      type: "human";
      origin: { type: "human"; userId: string };
      residualUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      deletedHashes?: { human?: readonly string[]; agent?: readonly string[] };
    };

export function createBranchAgentEditCoordinator(input: {
  threadId: ThreadId;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: BranchLookupWithSnapshots;
  pendingJournalEntries?: BranchPendingJournalEntries;
  branchPush?: AutoBranchPushPort;
  journalRows?: {
    listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
    listConcurrentJournalRows(
      branchId: string,
      generation: number,
      options: { afterJournalId?: number; documentId: DocumentId },
    ): Promise<BranchJournalRow[]>;
  };
  liveJournal?: Pick<ReversalStore, "readForReconstruction">;
  eventSink?: EventSink;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
}): DocumentCoordinator {
  const concurrentJournalWatermarks =
    input.concurrentJournalWatermarks ?? createBranchConcurrentJournalWatermarks();
  return {
    async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      const branchId = await ensureThreadBranch(input, docId as DocumentId);
      let autoPushBranchId: string | null = null;
      let result: T;
      try {
        result = await input.branchCoordinator.withBranchTransient(
          branchId,
          async (doc, snapshot) => {
            const beforeState = Y.encodeStateAsUpdate(doc);
            const result = await fn(doc);
            const pendingBatch =
              input.pendingJournalEntries?.shiftBatch(docId, input.threadId) ?? [];
            if (!bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
              const workDraftBranchId = snapshot.upstreamBranchId;
              if (!workDraftBranchId) {
                throw new Error(
                  `Thread-peer branch ${snapshot.branchId} has no work-draft upstream`,
                );
              }
              const pending = pendingBatch.at(-1);
              const mutation = pending?.mutation;
              if (mutation?.mode !== "threadPeer") {
                throw new Error("thread_peer_commit_missing_branch_generation");
              }
              const replacementScopes = pendingBatch.flatMap((entry) => {
                const scope = entry.mutation?.semanticEditIr?.scope;
                return scope && scope.length > 0 ? [scope] : [];
              });
              const sourceHasBranchDelta = await sourceDocHasBranchDelta(
                input.branchCoordinator,
                workDraftBranchId,
                doc,
              );
              if (!sourceHasBranchDelta) {
                emitStagedWriteNoop(input.eventSink, {
                  documentId: docId as DocumentId,
                  threadId: input.threadId,
                  branchId: workDraftBranchId,
                  turnId: pending?.mutation?.turnId ?? null,
                  writeId: pending?.mutation?.writeId ?? null,
                });
                throw new StagedBranchWriteNoopError(workDraftBranchId, docId);
              }
              const committed = await input.branchCoordinator.commitSyncFromDoc({
                branchId: workDraftBranchId,
                sourceDoc: doc,
                source: "agent",
                wId: pending?.mutation?.wId ?? null,
                threadId: (pending?.mutation?.threadId as ThreadId | undefined) ?? input.threadId,
                turnId: pending?.mutation?.turnId ?? null,
                expectedGeneration: mutation.branchGeneration,
                ...(mutation.branchJournalWatermark !== undefined
                  ? { expectedJournalWatermark: mutation.branchJournalWatermark }
                  : {}),
                ...(mutation.branchJournalRevision !== undefined
                  ? { expectedJournalRevision: mutation.branchJournalRevision }
                  : {}),
                updateMeta: branchUpdateMetaWithReplacementScopes(
                  pending?.meta ?? null,
                  replacementScopes,
                ),
                ...(mutation.semanticEditIr ? { semanticEditIr: mutation.semanticEditIr } : {}),
              });
              if (!committed) return result;
              autoPushBranchId = workDraftBranchId;
              advanceConcurrentJournalWatermark(
                concurrentJournalWatermarks,
                input.threadId,
                docId as DocumentId,
                pending?.mutation?.writeId,
              );
            } else if (pendingBatch.length > 0) {
              const workDraftBranchId = snapshot.upstreamBranchId ?? snapshot.branchId;
              const pending = pendingBatch.at(-1);
              emitStagedWriteNoop(input.eventSink, {
                documentId: docId as DocumentId,
                threadId: input.threadId,
                branchId: workDraftBranchId,
                turnId: pending?.mutation?.turnId ?? null,
                writeId: pending?.mutation?.writeId ?? null,
              });
              throw new StagedBranchWriteNoopError(workDraftBranchId, docId);
            }
            return result;
          },
        );
      } catch (cause) {
        concurrentJournalWatermarks.clearPending(input.threadId, docId as DocumentId);
        throw cause;
      }
      if (autoPushBranchId && input.branchPush) {
        scheduleAutoPushAfterCommit({
          workDraftBranchId: autoPushBranchId,
          branchPush: input.branchPush,
          eventSink: input.eventSink,
        });
      }
      return result;
    },

    async recover(docId: string): Promise<void> {
      await ensureThreadBranch(input, docId as DocumentId);
    },

    async concurrentUpdatesSince({
      docId,
      doc,
      baselineDoc,
      afterJournalId,
      liveJournalSeq,
      attemptId,
    }) {
      const baselineState = baselineDoc ? Y.encodeStateAsUpdate(baselineDoc) : null;
      const concurrent = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        afterJournalId,
      );
      try {
        // Durable upstream work-draft rows are never suppressed as "self" merely
        // because they came from this thread; the journal watermark is the fence.
        const liveRows = input.liveJournal
          ? liveAttributionRows(
              (await input.liveJournal.readForReconstruction(docId)).updates.filter(
                (update) => update.seq > (liveJournalSeq ?? Number.MAX_SAFE_INTEGER),
              ),
            )
          : [];
        const partitioned = partitionConcurrentUpdates({
          baselineState,
          journalRows: [...concurrent.rows, ...liveRows],
          currentUpstreamState: concurrent.upstreamState,
          fallbackCurrentUpstream: doc,
          model: input.model,
          codec: input.codec,
        });
        const maxRowId = partitioned.reduce(
          (max, item) => (item.type === "journal" ? Math.max(max, item.rowId) : max),
          0,
        );
        if (maxRowId > 0) {
          // Load-bearing: this is only a captured candidate. Advancing the floor here would
          // skip rows if the surrounding branch write later fails or CAS-exhausts.
          concurrentJournalWatermarks.capturePending(
            input.threadId,
            docId as DocumentId,
            maxRowId,
            attemptId,
          );
          // Capture itself is provisional: failures before branch persistence must
          // clear the candidate even though no watermark-advance participant exists yet.
          enlistResponseParticipant({
            commit() {},
            abort() {
              concurrentJournalWatermarks.clearPending(input.threadId, docId as DocumentId);
            },
          });
        }
        return partitioned.map((item) =>
          item.type === "journal"
            ? {
                update: item.effectiveUpdate,
                origin: item.origin,
                touchedHashes: item.touchedHashes,
                deletedHashes: item.deletedHashes,
              }
            : {
                update: item.residualUpdate,
                origin: item.origin,
                touchedHashes: item.touchedHashes,
                deletedHashes: item.deletedHashes,
              },
        );
      } finally {
        // baselineDoc is owned by the agent-edit core; this coordinator only snapshots it.
      }
    },
  };
}

export function createBranchAgentEditJournal(input: {
  threadId: ThreadId;
  liveJournal: UpdateJournal & ReversalStore;
  pendingJournalEntries?: BranchPendingJournalEntries;
  branches?: BranchLookupWithSnapshots;
  branchRows?: {
    listJournalRowsForBranch(input: {
      branchId: string;
      generation: number;
    }): Promise<BranchJournalRow[]>;
  };
}): UpdateJournal & ReversalStore {
  let syntheticSeq = 0;
  const groupedOrdinals = new Map<string, Promise<number>>();
  const pinnedReversalScope = new AsyncLocalStorage<{
    docId: string;
    scope: BranchReversalScope;
  }>();
  const materializeDestructiveProvenance = input.liveJournal.materializeDestructiveProvenance?.bind(
    input.liveJournal,
  );

  const resolveBranchScope = async (docId: string): Promise<BranchReversalScope | null> => {
    if (!input.branches) return null;
    return resolveBranchReversalScope({
      documentId: docId as DocumentId,
      threadId: input.threadId,
      branches: input.branches,
      branchRows: input.branchRows,
    });
  };

  const branchScope = async (docId: string): Promise<BranchReversalScope | null> => {
    const pinned = pinnedReversalScope.getStore();
    return pinned?.docId === docId ? pinned.scope : resolveBranchScope(docId);
  };

  const branchState = async (docId: string): Promise<BranchReversalState | null> => {
    const scope = await branchScope(docId);
    return scope ? buildBranchReversalState(input.threadId, scope.rows) : null;
  };

  return {
    async withReversalScope(docId, operation) {
      const scope = await resolveBranchScope(docId);
      if (!scope) {
        throw new Error("Branch reversal authority changed before the command began");
      }
      return pinnedReversalScope.run({ docId, scope }, operation);
    },

    async append(_docId, _update, _meta) {
      syntheticSeq += 1;
      return syntheticSeq;
    },

    async appendBatch(entries) {
      for (const entry of entries) {
        input.pendingJournalEntries?.push(entry);
        const groupId = entry.meta.authoringResponseId ?? entry.mutation?.turnId;
        if (groupId)
          groupedOrdinals.delete(groupedOrdinalKey(entry.docId, input.threadId, groupId));
      }
      return Promise.all(
        entries.map(async (entry): Promise<JournalBatchAppendResult> => {
          syntheticSeq += 1;
          return {
            seq: syntheticSeq,
            wId: entry.mutation?.wId,
            journalCommitKind: "staged",
          };
        }),
      );
    },

    read(_docId: string, _opts?: JournalReadOptions): Promise<JournalSnapshot> {
      return Promise.resolve({ checkpoint: null, updates: [] });
    },

    readAttribution(docId: string): Promise<JournalSnapshot> {
      return input.liveJournal.readAttribution?.(docId) ?? input.liveJournal.read(docId);
    },

    ...(materializeDestructiveProvenance
      ? {
          materializeDestructiveProvenance: (request) =>
            materializeDestructiveProvenance({
              ...request,
              // Roots absent from live authority were born on this agent-owned branch.
              fallbackProvenance: "agent",
            }),
        }
      : {}),

    checkpoint(_docId: string, _state: Uint8Array, _upToSeq: number): Promise<void> {
      return Promise.resolve();
    },

    compact(_docId, _before) {
      return Promise.resolve({ updatesFolded: 0, reversalsExpired: 0 });
    },

    async reserveWriteOrdinal(documentId, threadId, groupId) {
      if (!groupId) return input.liveJournal.reserveWriteOrdinal(documentId, threadId);
      const key = groupedOrdinalKey(documentId, threadId, groupId);
      const existing = groupedOrdinals.get(key);
      if (existing !== undefined) return existing;
      const reservation = input.liveJournal.reserveWriteOrdinal(documentId, threadId);
      groupedOrdinals.set(key, reservation);
      try {
        return await reservation;
      } catch (cause) {
        if (groupedOrdinals.get(key) === reservation) groupedOrdinals.delete(key);
        throw cause;
      }
    },
    async readForReconstruction(docId) {
      const scope = await branchScope(docId);
      if (!scope) return input.liveJournal.readForReconstruction(docId);
      const live = await input.liveJournal.readForReconstruction(docId);
      const persistenceWatermark = scope.rows.at(-1)?.id ?? 0;
      const checkpoint = materializeSnapshot(live);
      const updates = scope.rows.map(branchRowAsPersistedUpdate);
      const replayedState = materializeSnapshot({ checkpoint, updates });
      const reconciled = new Y.Doc({ gc: false });
      Y.applyUpdate(reconciled, replayedState);
      Y.applyUpdate(reconciled, scope.state);
      const authoritativeState = Y.encodeStateAsUpdate(reconciled);
      reconciled.destroy();
      const reconciliationUpdate = bytesEqual(replayedState, authoritativeState)
        ? []
        : [
            {
              seq: persistenceWatermark + 1,
              update: scope.state,
              meta: { origin: "system:branch-state", seq: persistenceWatermark + 1 },
            },
          ];
      return {
        checkpoint,
        updates: [...updates, ...reconciliationUpdate],
        persistenceWatermark,
      };
    },
    documentsForTurn(threadId, turnId) {
      return input.liveJournal.documentsForTurn(threadId, turnId);
    },
    async latestActiveWrite(documentId, threadId) {
      const state = await branchState(documentId);
      return state
        ? state.activeWrites.at(-1)
        : input.liveJournal.latestActiveWrite(documentId, threadId);
    },
    async activeWriteSummary(documentId, threadId) {
      const state = await branchState(documentId);
      return state
        ? state.activeWrites
        : input.liveJournal.activeWriteSummary(documentId, threadId);
    },
    async writeMinCreatedSeq(documentId, threadId, handle) {
      const state = await branchState(documentId);
      return state
        ? state.mutationsByHandle.get(handle)?.[0]?.createdSeq
        : input.liveJournal.writeMinCreatedSeq(documentId, threadId, handle);
    },
    async mutationsForWrite(documentId, threadId, handle) {
      const state = await branchState(documentId);
      return state
        ? (state.mutationsByHandle.get(handle) ?? [])
        : input.liveJournal.mutationsForWrite(documentId, threadId, handle);
    },
    async mutationsForWrites(documentId, threadId, handles) {
      const state = await branchState(documentId);
      if (!state) return input.liveJournal.mutationsForWrites(documentId, threadId, handles);
      return new Map(handles.map((handle) => [handle, state.mutationsByHandle.get(handle) ?? []]));
    },
    async persistUndo(docId, undoUpdate, records, actor = { type: "agent" }) {
      const scope = await branchScope(docId);
      if (!scope) return input.liveJournal.persistUndo(docId, undoUpdate, records, actor);
      stageBranchReversal({
        pending: input.pendingJournalEntries,
        docId,
        threadId: input.threadId,
        scope,
        expectedJournalWatermark: records.reduce(
          (watermark, record) => Math.min(watermark, record.persistGuardWatermark ?? 0),
          Number.POSITIVE_INFINITY,
        ),
        update: undoUpdate,
        actor,
        operation: {
          direction: "undo",
          records: records.map(serializeBranchReversalRecord),
        },
      });
      return { persisted: true, journalCommitKind: "staged" };
    },
    async persistRedo(docId, redoUpdate, ref, meta) {
      const result = await this.persistRedoBatch(docId, [{ update: redoUpdate, ref, meta }]);
      return {
        consumed: result.consumed,
        seq: result.seqs?.[0],
        journalCommitKind: result.journalCommitKind,
      };
    },
    async persistRedoBatch(docId, entries) {
      const scope = await branchScope(docId);
      if (!scope) return input.liveJournal.persistRedoBatch(docId, entries);
      if (entries.length === 0) return { consumed: false };
      stageBranchReversal({
        pending: input.pendingJournalEntries,
        docId,
        threadId: input.threadId,
        scope,
        expectedJournalWatermark: entries.reduce(
          (watermark, entry) => Math.min(watermark, entry.persistGuardWatermark ?? 0),
          Number.POSITIVE_INFINITY,
        ),
        update: Y.mergeUpdates(entries.map((entry) => entry.update)),
        actor: entries[0]?.meta.reversalActor ?? { type: "agent" },
        operation: {
          direction: "redo",
          refs: entries.map((entry) => entry.ref),
        },
      });
      return { consumed: true, journalCommitKind: "staged" };
    },
    async readReversals(docId, opts) {
      const state = await branchState(docId);
      if (!state) return input.liveJournal.readReversals(docId, opts);
      return state.reversals.filter(
        (record) =>
          (!opts?.threadId || record.threadId === opts.threadId) &&
          (!opts?.status || opts.status.includes(record.status)),
      );
    },
    async reversalOpSeqsForHandles(docId, threadId, handles) {
      const state = await branchState(docId);
      if (!state) return input.liveJournal.reversalOpSeqsForHandles(docId, threadId, handles);
      const selected = new Set(handles);
      return new Set(
        state.operationHandles.flatMap(({ seq, handles: operationHandles }) =>
          operationHandles.some((handle) => selected.has(handle)) ? [seq] : [],
        ),
      );
    },
  };
}

export class StagedBranchWriteNoopError extends Error {
  constructor(
    readonly branchId: string,
    readonly documentId: string,
  ) {
    super(
      `Staged write for document ${documentId} produced no durable branch journal row on branch ${branchId}`,
    );
    this.name = "StagedBranchWriteNoopError";
  }
}

function emitStagedWriteNoop(
  eventSink: EventSink | undefined,
  payload: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId: string;
    turnId: string | null;
    writeId: string | null;
  },
): void {
  if (!eventSink) return;
  emitEvent(eventSink, {
    level: "error",
    source: "collab.branch_agent_edit",
    name: "staged_write.no_durable_journal_row",
    payload,
  });
}

export type BranchLookupWithSnapshots = WorkDraftLookup &
  BranchResolver & {
    getBranch?(
      branchId: string,
    ): Promise<Pick<BranchSnapshot, "upstreamBranchId" | "generation" | "state"> | null>;
  };

type BranchPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shiftBatch(documentId: string, threadId?: ThreadId): JournalBatchAppendEntry[];
};

export function createBranchPendingJournalEntries(
  eventSink?: EventSink,
): BranchPendingJournalEntries {
  const byDocument = new Map<string, JournalBatchAppendEntry[]>();
  return {
    push(entry) {
      if (!entry.mutation) {
        if (eventSink)
          emitEvent(eventSink, {
            level: "warn",
            source: "collab.branch_pending_journal",
            name: "mutation_less_entry_dropped",
            payload: {
              documentId: entry.docId,
              origin: entry.meta.origin,
            },
          });
        return;
      }
      const entries = byDocument.get(entry.docId) ?? [];
      entries.push(entry);
      byDocument.set(entry.docId, entries);
      enlistResponseParticipant({
        commit() {},
        abort() {
          const pending = byDocument.get(entry.docId);
          if (!pending) return;
          const remaining = pending.filter((candidate) => candidate !== entry);
          if (remaining.length > 0) byDocument.set(entry.docId, remaining);
          else byDocument.delete(entry.docId);
        },
      });
    },
    shiftBatch(documentId, threadId) {
      const entries = byDocument.get(documentId);
      if (!entries || entries.length === 0) return [];
      const batchThreadId = threadId ?? entries[0]?.mutation?.threadId;
      const batch = batchThreadId
        ? entries.filter((entry) => entry.mutation?.threadId === batchThreadId)
        : [...entries];
      const remaining = batchThreadId
        ? entries.filter((entry) => entry.mutation?.threadId !== batchThreadId)
        : [];
      if (remaining.length > 0) byDocument.set(documentId, remaining);
      else byDocument.delete(documentId);
      return batch;
    },
  };
}

async function sourceDocHasBranchDelta(
  branchCoordinator: BranchCoordinator,
  branchId: string,
  sourceDoc: Y.Doc,
): Promise<boolean> {
  return branchCoordinator.readBranch(branchId, async (branchDoc) =>
    Boolean(yjsDeltaUpdate(sourceDoc, branchDoc)),
  );
}

function emptyDocState(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

async function ensureThreadBranch(
  input: {
    threadId: ThreadId;
    liveCoordinator: DocumentCoordinator;
    branches: BranchLookupWithSnapshots;
  },
  documentId: DocumentId,
): Promise<string> {
  try {
    return (await input.branches.resolveThreadBranch(documentId, input.threadId)).branchId;
  } catch (cause) {
    if (!isBranchNotFoundError(cause)) throw cause;
    const liveState = await input.liveCoordinator
      .withDocument(documentId, async (liveDoc) => Y.encodeStateAsUpdate(liveDoc))
      .catch((cause: unknown) => {
        if (cause instanceof DocumentNotFoundError) return emptyDocState();
        throw cause;
      });
    const liveDoc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(liveDoc, liveState);
      const peer = await input.branches.ensureThreadPeerBranch({
        documentId,
        threadId: input.threadId,
        liveDoc,
      });
      return peer.branchId;
    } finally {
      liveDoc.destroy();
    }
  }
}

async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    branchCoordinator: BranchCoordinator;
    branches: BranchLookupWithSnapshots;
    journalRows?: {
      listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
      listConcurrentJournalRows(
        branchId: string,
        generation: number,
        options: { afterJournalId?: number; documentId: DocumentId },
      ): Promise<BranchJournalRow[]>;
    };
  },
  documentId: DocumentId,
  afterJournalId?: number,
): Promise<{ rows: BranchJournalRow[]; upstreamState?: Uint8Array }> {
  if (!input.journalRows || !input.branches.getBranch) return { rows: [] };
  const journalRows = input.journalRows;
  const peer = await input.branches.resolveThreadBranch(documentId, input.threadId);
  peer.doc.destroy();
  const peerSnapshot = await input.branches.getBranch(peer.branchId);
  const upstreamBranchId = peerSnapshot?.upstreamBranchId;
  if (!upstreamBranchId) return { rows: [] };
  if (typeof input.branchCoordinator.readBranch === "function") {
    return input.branchCoordinator.readBranch(upstreamBranchId, async (doc, snapshot) => {
      const rows = await listConcurrentRows(journalRows, {
        branchId: upstreamBranchId,
        generation: snapshot.generation,
        afterJournalId,
        documentId,
      });
      return {
        rows,
        upstreamState: Y.encodeStateAsUpdate(doc),
      };
    });
  }
  const upstream = await input.branches.getBranch(upstreamBranchId);
  if (!upstream) return { rows: [] };
  const rows = await listConcurrentRows(journalRows, {
    branchId: upstreamBranchId,
    generation: upstream.generation,
    afterJournalId,
    documentId,
  });
  return { rows };
}

async function listConcurrentRows(
  journalRows: NonNullable<Parameters<typeof concurrentUpstreamJournalRows>[0]["journalRows"]>,
  input: {
    branchId: string;
    generation: number;
    afterJournalId?: number;
    documentId: DocumentId;
  },
): Promise<BranchJournalRow[]> {
  return journalRows.listConcurrentJournalRows(input.branchId, input.generation, {
    afterJournalId: input.afterJournalId,
    documentId: input.documentId,
  });
}

function originForJournalRow(row: BranchJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return { type: "agent" as const, actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent" };
  }
  return { type: "human" as const, userId: row.actorUserId ?? "unknown" };
}

function liveAttributionRows(updates: readonly PersistedUpdate[]): BranchJournalRow[] {
  return updates.map((update) => {
    const reversalActor = update.meta.reversalActor;
    const source =
      reversalActor?.type === "agent" || update.meta.origin.startsWith("agent:")
        ? "agent"
        : "writer";
    const actorUserId =
      reversalActor?.type === "user"
        ? reversalActor.userId
        : update.meta.origin.startsWith("human:")
          ? update.meta.origin.slice("human:".length)
          : null;
    return {
      id: -update.seq,
      branchId: "live-journal",
      generation: 0,
      wId: null,
      source,
      threadId: null,
      turnId: (update.meta.actorTurnId ?? null) as BranchJournalRow["turnId"],
      actorUserId: actorUserId as BranchJournalRow["actorUserId"],
      updateData: update.update,
      draftBaseUpdateSeq: 0,
      status: "pushed",
      updateMeta: update.meta,
    };
  });
}

function partitionConcurrentUpdates(
  input: ConcurrentAttributionBasis,
): PartitionedConcurrentUpdate[] {
  const upstreamState =
    input.currentUpstreamState ?? Y.encodeStateAsUpdate(input.fallbackCurrentUpstream);
  const coverage = partitionByBlockCoverage({
    baselineState: input.baselineState,
    upstreamState,
    rows: input.journalRows.map((row) => ({
      id: row.id,
      source: row.source,
      actorTurnId: actorTurnIdForJournalRow(row),
      update: row.updateData,
    })),
    model: input.model,
    codec: input.codec,
  });

  const scratch = docFromState(input.baselineState);
  try {
    const partitioned: PartitionedConcurrentUpdate[] = [];
    for (const row of input.journalRows) {
      const effectiveUpdate = effectiveUpdateFromApplyingToScratch(scratch, row.updateData);
      if (!effectiveUpdate) Y.applyUpdate(scratch, row.updateData);
      const actorTurnId = actorTurnIdForJournalRow(row);
      const touchedHashes = touchedHashesForCoverage(coverage.coverage, row.source, actorTurnId);
      const deletedHashes = touchedHashesForCoverage(
        coverage.deletedCoverage,
        row.source,
        actorTurnId,
      );
      if (effectiveUpdate || touchedHashes || deletedHashes) {
        partitioned.push({
          type: "journal",
          rowId: row.id,
          origin: originForJournalRow(row),
          effectiveUpdate: effectiveUpdate ?? new Uint8Array(),
          touchedHashes: touchedHashes ?? (effectiveUpdate ? {} : undefined),
          deletedHashes,
        });
      }
    }

    const target = yjsUpdateFromState(upstreamState);
    try {
      const residualUpdate = yjsDeltaUpdate(target, scratch) ?? new Uint8Array();
      if (
        residualUpdate.length > 0 ||
        coverage.humanResidualHashes.size > 0 ||
        coverage.humanDeletedHashes.size > 0
      ) {
        partitioned.push({
          type: "human",
          origin: { type: "human", userId: "unknown" },
          residualUpdate,
          touchedHashes:
            coverage.humanResidualHashes.size > 0
              ? { human: [...coverage.humanResidualHashes] }
              : residualUpdate.length > 0
                ? {}
                : undefined,
          deletedHashes:
            coverage.humanDeletedHashes.size > 0
              ? { human: [...coverage.humanDeletedHashes] }
              : undefined,
        });
      }
    } finally {
      target.destroy();
    }
    return partitioned;
  } finally {
    scratch.destroy();
  }
}

function actorTurnIdForJournalRow(row: BranchJournalRow): string | null {
  if (row.source !== "agent") return null;
  return row.turnId ?? row.threadId ?? "unknown-agent";
}

function effectiveUpdateFromApplyingToScratch(
  scratch: Y.Doc,
  update: Uint8Array,
): Uint8Array | null {
  const probe = cloneYDoc(scratch);
  try {
    Y.applyUpdate(probe, update);
    const effective = yjsDeltaUpdate(probe, scratch);
    if (!effective) return null;
    Y.applyUpdate(scratch, effective);
    return effective;
  } finally {
    probe.destroy();
  }
}

function advanceConcurrentJournalWatermark(
  watermarks: BranchConcurrentJournalWatermarks,
  threadId: ThreadId,
  documentId: DocumentId,
  attemptId?: string,
): void {
  if (
    enlistResponseParticipant({
      commit() {
        watermarks.commitPending(threadId, documentId, attemptId);
      },
      abort() {
        watermarks.clearPending(threadId, documentId);
      },
    })
  ) {
    return;
  }
  runAfterDrizzleCommit(() => {
    watermarks.commitPending(threadId, documentId, attemptId);
  });
}

function scheduleAutoPushAfterCommit(input: {
  workDraftBranchId: string;
  branchPush: AutoBranchPushPort;
  eventSink?: EventSink;
}): void {
  runAfterDrizzleCommit(() => {
    void input.branchPush
      .pushAutoBranchAfterThreadPeerWrite({ workDraftBranchId: input.workDraftBranchId })
      .then((result) => {
        if (
          result.status === "pushed" ||
          result.status === "already_pushed" ||
          result.status === "skipped"
        ) {
          return;
        }
        const payload = { workDraftBranchId: input.workDraftBranchId, result };
        if (input.eventSink) {
          emitEvent(input.eventSink, {
            level: "error",
            source: "collab.branch_auto_push",
            name: "auto_push.unapplied",
            payload,
          });
          return;
        }
        console.error("Branch auto-push resolved without applying", payload);
      })
      .catch((cause: unknown) => {
        if (input.eventSink) {
          emitEvent(input.eventSink, {
            level: "error",
            source: "collab.branch_auto_push",
            name: "auto_push.failed",
            payload: {
              workDraftBranchId: input.workDraftBranchId,
              ...unknownToEventPayload(cause),
            },
          });
          return;
        }
        console.error("Branch auto-push failed", {
          workDraftBranchId: input.workDraftBranchId,
          cause,
        });
      });
  });
}
