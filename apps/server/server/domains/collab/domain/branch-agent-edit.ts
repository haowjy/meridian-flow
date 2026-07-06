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
import type { BranchPushService } from "./branch-push.js";
import { type BranchResolver, isBranchNotFoundError } from "./branch-resolver.js";

export function createBranchAgentEditCoordinator(input: {
  threadId: ThreadId;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: WorkDraftLookup & BranchResolver;
  pendingJournalEntries?: BranchPendingJournalEntries;
  branchPush?: Pick<BranchPushService, "pushAutoBranchAfterThreadPeerWrite">;
  eventSink?: EventSink;
}): DocumentCoordinator {
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

export type BranchPendingJournalEntries = {
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

async function ensureThreadBranch(
  input: {
    threadId: ThreadId;
    liveCoordinator: DocumentCoordinator;
    branches: WorkDraftLookup & BranchResolver;
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
