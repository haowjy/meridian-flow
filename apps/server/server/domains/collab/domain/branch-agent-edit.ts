/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */
import {
  bytesEqual,
  cloneYDoc,
  type DocumentCoordinator,
  DocumentNotFoundError,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalReadOptions,
  type JournalSnapshot,
  type ReversalStore,
  type UpdateJournal,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { WorkDraftLookup } from "./branch-pulls.js";
import type { BranchJournalRow, BranchPushService } from "./branch-push.js";
import { type BranchResolver, isBranchNotFoundError } from "./branch-resolver.js";

type ConcurrentUpdateOrigin =
  | { type: "human"; userId?: string }
  | { type: "agent"; actorTurnId: string };

type ConcurrentAttributionBasis = {
  prePullBaseline: Y.Doc;
  currentUpstreamState?: Uint8Array;
  fallbackCurrentUpstream: Y.Doc;
  journalRows: readonly BranchJournalRow[];
};

type PartitionedConcurrentUpdate =
  | {
      type: "journal";
      rowId: number;
      origin: ConcurrentUpdateOrigin;
      effectiveUpdate: Uint8Array;
    }
  | {
      type: "human";
      origin: { type: "human" };
      residualUpdate: Uint8Array;
    };

export function createBranchAgentEditCoordinator(input: {
  threadId: ThreadId;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: BranchLookupWithSnapshots;
  pendingJournalEntries?: BranchPendingJournalEntries;
  branchPush?: Pick<BranchPushService, "pushAutoBranchAfterThreadPeerWrite">;
  journalRows?: {
    listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
    listConcurrentJournalRows?(
      branchId: string,
      generation: number,
      options?: { afterJournalId?: number },
    ): Promise<BranchJournalRow[]>;
  };
  eventSink?: EventSink;
}): DocumentCoordinator {
  const concurrentJournalWatermarkByDocument = new Map<DocumentId, number>();
  const pendingConcurrentJournalWatermarkByDocument = new Map<DocumentId, number>();
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
            if (!bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
              const workDraftBranchId = snapshot.upstreamBranchId;
              if (!workDraftBranchId) {
                throw new Error(
                  `Thread-peer branch ${snapshot.branchId} has no work-draft upstream`,
                );
              }
              const pending = input.pendingJournalEntries?.shift(docId);
              const committed = await input.branchCoordinator.commitSyncFromDoc({
                branchId: workDraftBranchId,
                sourceDoc: doc,
                source: "agent",
                wId: pending?.mutation?.wId ?? null,
                threadId: (pending?.mutation?.threadId as ThreadId | undefined) ?? input.threadId,
                turnId: pending?.mutation?.turnId ?? null,
                updateMeta: pending?.meta ?? null,
              });
              if (committed) {
                autoPushBranchId = workDraftBranchId;
                advanceConcurrentJournalWatermark(
                  concurrentJournalWatermarkByDocument,
                  pendingConcurrentJournalWatermarkByDocument,
                  docId as DocumentId,
                );
              }
            }
            return result;
          },
        );
      } catch (cause) {
        pendingConcurrentJournalWatermarkByDocument.delete(docId as DocumentId);
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

    async concurrentUpdatesSince({ docId, doc, baselineDoc }) {
      const baseline = baselineDoc ? cloneDoc(baselineDoc) : new Y.Doc({ gc: false });
      const concurrent = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        concurrentJournalWatermarkByDocument.get(docId as DocumentId),
      );
      try {
        const partitioned = partitionConcurrentUpdates({
          prePullBaseline: baseline,
          journalRows: concurrent.rows,
          currentUpstreamState: concurrent.upstreamState,
          fallbackCurrentUpstream: doc,
        });
        const maxRowId = partitioned.reduce(
          (max, item) => (item.type === "journal" ? Math.max(max, item.rowId) : max),
          0,
        );
        if (maxRowId > 0) {
          // Load-bearing: this is only a captured candidate. Advancing the floor here would
          // skip rows if the surrounding branch write later fails or CAS-exhausts.
          pendingConcurrentJournalWatermarkByDocument.set(docId as DocumentId, maxRowId);
        }
        return partitioned.map((item) =>
          item.type === "journal"
            ? { update: item.effectiveUpdate, origin: item.origin }
            : { update: item.residualUpdate, origin: item.origin },
        );
      } finally {
        baseline.destroy();
      }
    },
  };
}

export function createBranchAgentEditJournal(input: {
  threadId: ThreadId;
  liveJournal: UpdateJournal & ReversalStore;
  pendingJournalEntries?: BranchPendingJournalEntries;
}): UpdateJournal & ReversalStore {
  let syntheticSeq = 0;
  return {
    async append(_docId, _update, _meta) {
      syntheticSeq += 1;
      return syntheticSeq;
    },

    async appendBatch(entries) {
      for (const entry of entries) input.pendingJournalEntries?.push(entry);
      return Promise.all(
        entries.map(async (entry): Promise<JournalBatchAppendResult> => {
          syntheticSeq += 1;
          return {
            seq: syntheticSeq,
            wId: entry.mutation?.wId,
          };
        }),
      );
    },

    read(_docId: string, _opts?: JournalReadOptions): Promise<JournalSnapshot> {
      return Promise.resolve({ checkpoint: null, updates: [] });
    },

    checkpoint(_docId: string, _state: Uint8Array, _upToSeq: number): Promise<void> {
      return Promise.resolve();
    },

    compact(_docId, _before) {
      return Promise.resolve({ updatesFolded: 0, reversalsExpired: 0 });
    },

    reserveWriteOrdinal(documentId, threadId) {
      return input.liveJournal.reserveWriteOrdinal(documentId, threadId);
    },
    readForReconstruction(docId) {
      return input.liveJournal.readForReconstruction(docId);
    },
    documentsForTurn(threadId, turnId) {
      return input.liveJournal.documentsForTurn(threadId, turnId);
    },
    latestActiveWrite(documentId, threadId) {
      return input.liveJournal.latestActiveWrite(documentId, threadId);
    },
    activeWriteSummary(documentId, threadId) {
      return input.liveJournal.activeWriteSummary(documentId, threadId);
    },
    writeMinCreatedSeq(documentId, threadId, handle) {
      return input.liveJournal.writeMinCreatedSeq(documentId, threadId, handle);
    },
    mutationsForWrite(documentId, threadId, handle) {
      return input.liveJournal.mutationsForWrite(documentId, threadId, handle);
    },
    mutationsForWrites(documentId, threadId, handles) {
      return input.liveJournal.mutationsForWrites(documentId, threadId, handles);
    },
    persistUndo(docId, undoUpdate, records, actor) {
      return input.liveJournal.persistUndo(docId, undoUpdate, records, actor);
    },
    persistRedo(docId, redoUpdate, ref, meta) {
      return input.liveJournal.persistRedo(docId, redoUpdate, ref, meta);
    },
    readReversals(docId, opts) {
      return input.liveJournal.readReversals(docId, opts);
    },
    reversalOpSeqsForHandles(docId, threadId, handles) {
      return input.liveJournal.reversalOpSeqsForHandles(docId, threadId, handles);
    },
  };
}

export type BranchLookupWithSnapshots = WorkDraftLookup &
  BranchResolver & {
    getBranch?(
      branchId: string,
    ): Promise<{ upstreamBranchId: string | null; generation: number } | null>;
  };

type BranchPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shift(documentId: string): JournalBatchAppendEntry | undefined;
};

export function createBranchPendingJournalEntries(): BranchPendingJournalEntries {
  const byDocument = new Map<string, JournalBatchAppendEntry[]>();
  return {
    push(entry) {
      const entries = byDocument.get(entry.docId) ?? [];
      entries.push(entry);
      byDocument.set(entry.docId, entries);
    },
    shift(documentId) {
      const entries = byDocument.get(documentId);
      const entry = entries?.shift();
      if (entries && entries.length === 0) byDocument.delete(documentId);
      return entry;
    },
  };
}

async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    branchCoordinator: BranchCoordinator;
    branches: BranchLookupWithSnapshots;
    journalRows?: {
      listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
      listConcurrentJournalRows?(
        branchId: string,
        generation: number,
        options?: { afterJournalId?: number },
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
  });
  return { rows };
}

async function listConcurrentRows(
  journalRows: NonNullable<Parameters<typeof concurrentUpstreamJournalRows>[0]["journalRows"]>,
  input: { branchId: string; generation: number; afterJournalId?: number },
): Promise<BranchJournalRow[]> {
  if (journalRows.listConcurrentJournalRows) {
    return journalRows.listConcurrentJournalRows(
      input.branchId,
      input.generation,
      input.afterJournalId === undefined ? {} : { afterJournalId: input.afterJournalId },
    );
  }
  const rows = await journalRows.listActiveJournalRows(input.branchId, input.generation);
  const afterJournalId = input.afterJournalId;
  return afterJournalId === undefined ? rows : rows.filter((row) => row.id > afterJournalId);
}

function originForJournalRow(row: BranchJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return { type: "agent" as const, actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent" };
  }
  return { type: "human" as const, userId: row.actorUserId ?? undefined };
}

function partitionConcurrentUpdates(
  input: ConcurrentAttributionBasis,
): PartitionedConcurrentUpdate[] {
  const scratch = input.prePullBaseline;
  const partitioned: PartitionedConcurrentUpdate[] = [];
  const coveredNoopAgentRows: BranchJournalRow[] = [];
  for (const row of input.journalRows) {
    const effectiveUpdate = effectiveUpdateFromApplyingToScratch(scratch, row.updateData);
    if (effectiveUpdate) {
      partitioned.push({
        type: "journal",
        rowId: row.id,
        origin: originForJournalRow(row),
        effectiveUpdate,
      });
      if (row.source === "agent" && !stateVectorCoversUpdate(scratch, row.updateData)) {
        coveredNoopAgentRows.push(row);
      }
      continue;
    }

    // Metadata is authoritative: a semantic no-op row is still covered so its
    // content cannot be reclassified as human residual. Re-applying the row is
    // harmless for ordinary no-ops and preserves causal coverage when later rows
    // depend on it.
    if (row.source === "agent" && !stateVectorCoversUpdate(scratch, row.updateData)) {
      coveredNoopAgentRows.push(row);
    }
    Y.applyUpdate(scratch, row.updateData);
  }

  const target = input.currentUpstreamState
    ? yjsUpdateFromState(input.currentUpstreamState)
    : cloneYDoc(input.fallbackCurrentUpstream);
  try {
    const residualUpdate = yjsDeltaUpdate(target, scratch);
    if (residualUpdate) {
      const coveredAgent = coveredNoopAgentRows.find((row) =>
        updatesShareClient(row.updateData, residualUpdate),
      );
      if (coveredAgent) {
        partitioned.push({
          type: "journal",
          rowId: coveredAgent.id,
          origin: originForJournalRow(coveredAgent),
          effectiveUpdate: residualUpdate,
        });
      } else {
        partitioned.push({ type: "human", origin: { type: "human" }, residualUpdate });
      }
    }
  } finally {
    target.destroy();
  }
  return partitioned;
}

function stateVectorCoversUpdate(doc: Y.Doc, update: Uint8Array): boolean {
  const docClocks = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))) {
    if ((docClocks.get(client) ?? 0) < clock) return false;
  }
  return true;
}

function updatesShareClient(left: Uint8Array, right: Uint8Array): boolean {
  const clients = new Set<number>();
  const leftDecoded = Y.decodeUpdate(left);
  for (const struct of leftDecoded.structs) clients.add(struct.id.client);
  for (const client of leftDecoded.ds.clients.keys()) clients.add(client);
  const rightDecoded = Y.decodeUpdate(right);
  for (const struct of rightDecoded.structs) {
    if (clients.has(struct.id.client)) return true;
  }
  for (const client of rightDecoded.ds.clients.keys()) {
    if (clients.has(client)) return true;
  }
  return false;
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

function cloneDoc(doc: Y.Doc): Y.Doc {
  return cloneYDoc(doc);
}

function advanceConcurrentJournalWatermark(
  committed: Map<DocumentId, number>,
  pending: Map<DocumentId, number>,
  documentId: DocumentId,
): void {
  const maxRowId = pending.get(documentId);
  if (maxRowId === undefined) return;
  pending.delete(documentId);
  committed.set(documentId, Math.max(committed.get(documentId) ?? 0, maxRowId));
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

function emptyDocState(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function scheduleAutoPushAfterCommit(input: {
  workDraftBranchId: string;
  branchPush: Pick<BranchPushService, "pushAutoBranchAfterThreadPeerWrite">;
  eventSink?: EventSink;
}): void {
  runAfterDrizzleCommit(() => {
    void input.branchPush
      .pushAutoBranchAfterThreadPeerWrite({ workDraftBranchId: input.workDraftBranchId })
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
