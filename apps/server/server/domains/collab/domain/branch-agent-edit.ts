/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalReadOptions,
  type JournalSnapshot,
  type ReversalStore,
  type UpdateJournal,
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
  return {
    async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      const branchId = await ensureThreadBranch(input, docId as DocumentId);
      let autoPushBranchId: string | null = null;
      const result = await input.branchCoordinator.withBranchTransient(
        branchId,
        async (doc, snapshot) => {
          const beforeState = Y.encodeStateAsUpdate(doc);
          const result = await fn(doc);
          if (!bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
            const workDraftBranchId = snapshot.upstreamBranchId;
            if (!workDraftBranchId) {
              throw new Error(`Thread-peer branch ${snapshot.branchId} has no work-draft upstream`);
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
            if (committed) autoPushBranchId = workDraftBranchId;
          }
          return result;
        },
      );
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
        const partitioned: Array<{
          rowId?: number;
          update: Uint8Array;
          origin: ConcurrentUpdateOrigin;
        }> = [];
        for (const row of concurrent.rows) {
          const update = updateFromApplyingToScratch(baseline, row.updateData);
          if (update) partitioned.push({ rowId: row.id, update, origin: originForJournalRow(row) });
        }
        if (concurrent.upstreamState && partitioned.length > 0) {
          partitioned[partitioned.length - 1].update = concurrent.upstreamState;
        }
        const residual = residualUpdate(baseline, doc);
        if (residual) partitioned.push({ update: residual, origin: { type: "human" as const } });
        const maxRowId = partitioned.reduce((max, row) => Math.max(max, row.rowId ?? 0), 0);
        if (maxRowId > 0) concurrentJournalWatermarkByDocument.set(docId as DocumentId, maxRowId);
        return partitioned.map(({ update, origin }) => ({ update, origin }));
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
        ...(rows.length > 0 ? { upstreamState: Y.encodeStateAsUpdate(doc) } : {}),
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

function listConcurrentRows(
  journalRows: NonNullable<Parameters<typeof concurrentUpstreamJournalRows>[0]["journalRows"]>,
  input: { branchId: string; generation: number; afterJournalId?: number },
): Promise<BranchJournalRow[]> {
  return journalRows.listConcurrentJournalRows
    ? journalRows.listConcurrentJournalRows(input.branchId, input.generation, {
        afterJournalId: input.afterJournalId,
      })
    : journalRows.listActiveJournalRows(input.branchId, input.generation);
}

function originForJournalRow(row: BranchJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return { type: "agent" as const, actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent" };
  }
  return { type: "human" as const, userId: row.actorUserId ?? undefined };
}

function updateFromApplyingToScratch(scratch: Y.Doc, update: Uint8Array): Uint8Array | null {
  const beforeState = Y.encodeStateAsUpdate(scratch);
  Y.applyUpdate(scratch, update);
  if (bytesEqual(beforeState, Y.encodeStateAsUpdate(scratch))) return null;
  return Y.encodeStateAsUpdate(scratch);
}

function residualUpdate(scratch: Y.Doc, target: Y.Doc): Uint8Array | null {
  const residual = Y.encodeStateAsUpdate(target, Y.encodeStateVector(scratch));
  const probe = cloneDoc(scratch);
  try {
    return updateChangesDoc(probe, residual) ? residual : null;
  } finally {
    probe.destroy();
  }
}

function updateChangesDoc(doc: Y.Doc, update: Uint8Array): boolean {
  const beforeState = Y.encodeStateAsUpdate(doc);
  Y.applyUpdate(doc, update);
  return !bytesEqual(beforeState, Y.encodeStateAsUpdate(doc));
}

function cloneDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
