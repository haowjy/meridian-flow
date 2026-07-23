/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */
import {
  type ActiveWriteSummary,
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
  type PersistRedoEntry,
  type ReversalActor,
  type ReversalRecord,
  type ReversalStore,
  type UpdateJournal,
  type UpdateMeta,
  type WriteMutationRow,
  writeHandle,
  type YProsemirrorDocumentModel,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { WorkDraftLookup } from "./branch-pulls.js";
import type { AutoBranchPushPort, BranchJournalRow } from "./branch-push-contracts.js";
import { type BranchResolver, isBranchNotFoundError } from "./branch-resolver.js";
import {
  docFromState,
  partitionByBlockCoverage,
  touchedHashesForCoverage,
} from "./branch-update-attribution.js";
import { enlistResponseParticipant } from "./response-transaction.js";

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
                updateMeta: pending?.meta ?? null,
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
  const materializeDestructiveProvenance = input.liveJournal.materializeDestructiveProvenance?.bind(
    input.liveJournal,
  );

  const branchScope = async (docId: string): Promise<BranchReversalScope | null> => {
    if (!input.branches) return null;
    if (!input.branches.getBranch || !input.branchRows) {
      throw new Error("Branch reversal history is unavailable");
    }
    const peer = await input.branches.resolveThreadBranch(docId as DocumentId, input.threadId);
    peer.doc.destroy();
    const peerSnapshot = await input.branches.getBranch(peer.branchId);
    if (!peerSnapshot?.upstreamBranchId) return null;
    const workDraft = await input.branches.getBranch(peerSnapshot.upstreamBranchId);
    if (!workDraft) return null;
    const rows = await input.branchRows.listJournalRowsForBranch({
      branchId: peerSnapshot.upstreamBranchId,
      generation: workDraft.generation,
    });
    const ownsHistory = rows.some(
      (row) =>
        row.status === "active" &&
        row.source === "agent" &&
        row.threadId === input.threadId &&
        row.wId !== null,
    );
    return ownsHistory
      ? {
          branchId: peerSnapshot.upstreamBranchId,
          generation: workDraft.generation,
          rows,
        }
      : null;
  };

  const branchState = async (docId: string): Promise<BranchReversalState | null> => {
    const scope = await branchScope(docId);
    return scope ? buildBranchReversalState(input.threadId, scope.rows) : null;
  };

  return {
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

    async recordWriterProtectionScope({ docId, responseId, token }) {
      input.pendingJournalEntries?.recordWriterProtectionScope({
        documentId: docId,
        responseId,
        token,
      });
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
      return {
        checkpoint: materializeSnapshot(live),
        updates: scope.rows.map(branchRowAsPersistedUpdate),
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

type BranchReversalScope = {
  branchId: string;
  generation: number;
  rows: BranchJournalRow[];
};

type SerializedBranchReversalRecord = Omit<
  ReversalRecord,
  "undoUpdateSeq" | "redoUpdateSeq" | "reversedAt" | "expiresAt" | "persistGuardWatermark"
> & {
  reversedAt?: string;
  expiresAt?: string;
};

type BranchReversalOperation =
  | {
      direction: "undo";
      records: SerializedBranchReversalRecord[];
    }
  | {
      direction: "redo";
      refs: PersistRedoEntry["ref"][];
    };

type BranchReversalMeta = UpdateMeta & {
  branchReversal?: BranchReversalOperation;
};

type BranchReversalState = {
  activeWrites: ActiveWriteSummary[];
  mutationsByHandle: Map<string, WriteMutationRow[]>;
  reversals: ReversalRecord[];
  operationHandles: Array<{ seq: number; handles: string[] }>;
};

function groupedOrdinalKey(documentId: string, threadId: string, groupId: string): string {
  return `${documentId}:${threadId}:${groupId}`;
}

function stageBranchReversal(input: {
  pending: BranchPendingJournalEntries | undefined;
  docId: string;
  threadId: ThreadId;
  scope: BranchReversalScope;
  update: Uint8Array;
  actor: ReversalActor;
  operation: BranchReversalOperation;
}): void {
  if (!input.pending) throw new Error("Branch reversal persistence is unavailable");
  const turnId =
    input.operation.direction === "undo" ? (input.operation.records[0]?.turnId ?? null) : null;
  const authoringResponseId = input.actor.type === "agent" ? input.actor.responseId : undefined;
  const meta: BranchReversalMeta = {
    origin: "system",
    seq: 0,
    reversalActor: input.actor,
    ...(authoringResponseId ? { authoringResponseId } : {}),
    branchReversal: input.operation,
  };
  input.pending.push({
    docId: input.docId,
    update: input.update,
    meta,
    mutation: {
      mode: "threadPeer",
      branchGeneration: input.scope.generation,
      branchJournalWatermark: input.scope.rows.reduce((latest, row) => Math.max(latest, row.id), 0),
      actorKind: "system",
      threadId: input.threadId,
      turnId,
      systemOrigin: input.operation.direction,
      ...(authoringResponseId ? { authoringResponseId } : {}),
    },
  });
}

function serializeBranchReversalRecord(record: ReversalRecord): SerializedBranchReversalRecord {
  return {
    documentId: record.documentId,
    turnId: record.turnId,
    threadId: record.threadId,
    writeIds: [...record.writeIds],
    status: record.status,
    ...(record.authoringResponseId ? { authoringResponseId: record.authoringResponseId } : {}),
    ...(record.reversedByUserId ? { reversedByUserId: record.reversedByUserId } : {}),
    ...(record.reversedAt ? { reversedAt: record.reversedAt.toISOString() } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
  };
}

/** Final live mutation rows after folding branch-local undo/redo operations at Apply. */
export function activeBranchAgentWriteRows(
  rows: readonly BranchJournalRow[],
): Array<BranchJournalRow & { threadId: ThreadId; wId: number }> {
  const forwardByHandle = new Map<string, BranchJournalRow & { threadId: ThreadId; wId: number }>();
  const activeHandles = new Set<string>();
  const undoneHandlesBySeq = new Map<number, string[]>();
  const key = (threadId: string, handle: string) => `${threadId}:${handle}`;

  for (const row of rows) {
    if (row.source === "agent" && row.threadId !== null && row.wId !== null) {
      const handleKey = key(row.threadId, writeHandle(row.wId));
      forwardByHandle.set(handleKey, row as BranchJournalRow & { threadId: ThreadId; wId: number });
      activeHandles.add(handleKey);
    }
    const operation = branchReversalOperation(row);
    if (!operation) continue;
    if (operation.direction === "undo") {
      const undone: string[] = [];
      for (const record of operation.records) {
        for (const handle of record.writeIds) {
          const handleKey = key(record.threadId, handle);
          activeHandles.delete(handleKey);
          undone.push(handleKey);
        }
      }
      undoneHandlesBySeq.set(row.id, undone);
      continue;
    }
    for (const ref of operation.refs) {
      for (const handleKey of undoneHandlesBySeq.get(ref.undoUpdateSeq) ?? []) {
        if (handleKey.startsWith(`${ref.threadId}:`)) activeHandles.add(handleKey);
      }
    }
  }

  return [...activeHandles]
    .flatMap((handleKey) => {
      const row = forwardByHandle.get(handleKey);
      return row ? [row] : [];
    })
    .sort((left, right) => left.id - right.id);
}

function buildBranchReversalState(
  threadId: ThreadId,
  rows: readonly BranchJournalRow[],
): BranchReversalState {
  const forwardRows = rows.filter(
    (row) =>
      row.status === "active" &&
      row.source === "agent" &&
      row.threadId === threadId &&
      row.wId !== null &&
      !branchReversalOperation(row),
  );
  const reversalsByHandle = new Map<string, ReversalRecord>();
  const operationHandles: Array<{ seq: number; handles: string[] }> = [];

  for (const row of rows) {
    if (row.status !== "active") continue;
    const operation = branchReversalOperation(row);
    if (!operation) continue;
    if (operation.direction === "undo") {
      const handles: string[] = [];
      for (const serialized of operation.records) {
        const { reversedAt, expiresAt, ...record } = serialized;
        for (const handle of serialized.writeIds) {
          handles.push(handle);
          reversalsByHandle.set(handle, {
            ...record,
            writeIds: [handle],
            status: "reversed",
            undoUpdateSeq: row.id,
            ...(reversedAt ? { reversedAt: new Date(reversedAt) } : {}),
            ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
          });
        }
      }
      operationHandles.push({ seq: row.id, handles });
      continue;
    }

    const handles: string[] = [];
    for (const ref of operation.refs) {
      for (const [handle, record] of reversalsByHandle) {
        if (record.threadId !== ref.threadId || record.undoUpdateSeq !== ref.undoUpdateSeq)
          continue;
        handles.push(handle);
        reversalsByHandle.set(handle, {
          ...record,
          status: "redone",
          redoUpdateSeq: row.id,
        });
      }
    }
    operationHandles.push({ seq: row.id, handles });
  }

  const mutationsByHandle = new Map<string, WriteMutationRow[]>();
  const writes: ActiveWriteSummary[] = [];
  for (const row of forwardRows) {
    const handle = writeHandle(row.wId as number);
    const reversal = reversalsByHandle.get(handle);
    const mutation: WriteMutationRow = {
      writeId: handle,
      handle,
      wId: row.wId as number,
      turnId: row.turnId,
      createdSeq: row.id,
      status: reversal?.status === "reversed" ? "reversed" : "active",
      ...(reversal?.status === "reversed" ? { undoUpdateSeq: reversal.undoUpdateSeq } : {}),
    };
    mutationsByHandle.set(handle, [mutation]);
    if (mutation.status === "active") {
      writes.push({
        writeId: handle,
        handle,
        wId: mutation.wId,
        turnId: mutation.turnId,
        createdSeq: mutation.createdSeq,
      });
    }
  }

  return {
    activeWrites: writes.sort((left, right) => left.createdSeq - right.createdSeq),
    mutationsByHandle,
    reversals: [...reversalsByHandle.values()],
    operationHandles,
  };
}

function branchReversalOperation(row: BranchJournalRow): BranchReversalOperation | undefined {
  const meta = row.updateMeta as BranchReversalMeta | null | undefined;
  const operation = meta?.branchReversal;
  if (operation?.direction === "undo" && Array.isArray(operation.records)) return operation;
  if (operation?.direction === "redo" && Array.isArray(operation.refs)) return operation;
  return undefined;
}

function branchRowAsPersistedUpdate(row: BranchJournalRow): PersistedUpdate {
  const stored = (row.updateMeta ?? {}) as Partial<UpdateMeta>;
  return {
    seq: row.id,
    update: row.updateData,
    meta: {
      origin:
        stored.origin ??
        (row.source === "agent" ? `agent:${row.turnId ?? row.threadId ?? "branch"}` : "system"),
      seq: row.id,
      ...(stored.actorTurnId ? { actorTurnId: stored.actorTurnId } : {}),
      ...(stored.authoringResponseId ? { authoringResponseId: stored.authoringResponseId } : {}),
      ...(stored.sealedWriterLineage ? { sealedWriterLineage: stored.sealedWriterLineage } : {}),
      ...(stored.reversalActor ? { reversalActor: stored.reversalActor } : {}),
    },
  };
}

function materializeSnapshot(snapshot: JournalSnapshot): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
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
    ): Promise<{ upstreamBranchId: string | null; generation: number } | null>;
  };

type BranchPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shiftBatch(documentId: string, threadId?: ThreadId): JournalBatchAppendEntry[];
  recordWriterProtectionScope(input: {
    documentId: string;
    responseId: string;
    token: NonNullable<JournalBatchAppendEntry["meta"]["sealedWriterLineage"]>;
  }): void;
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
    recordWriterProtectionScope({ documentId, responseId, token }) {
      for (const entry of byDocument.get(documentId) ?? []) {
        if (entry.mutation?.authoringResponseId === responseId) {
          entry.meta.sealedWriterLineage = token;
        }
      }
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
