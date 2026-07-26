/** Branch-local reversal history projection and staged persistence. */
import {
  type ActiveWriteSummary,
  type JournalBatchAppendEntry,
  type JournalSnapshot,
  type PersistedUpdate,
  type PersistRedoEntry,
  type ReversalActor,
  type ReversalRecord,
  type UpdateMeta,
  type WriteMutationRow,
  writeHandle,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import { type BranchJournalRow, branchJournalRevision } from "./branch-push-contracts.js";

export type BranchReversalScope = {
  branchId: string;
  generation: number;
  state: Uint8Array;
  rows: BranchJournalRow[];
};

export async function resolveBranchReversalScope(input: {
  documentId: DocumentId;
  threadId: ThreadId;
  branches: {
    resolveThreadBranch(
      documentId: DocumentId,
      threadId: ThreadId,
    ): Promise<{ branchId: string; doc: Y.Doc }>;
    getBranch?(
      branchId: string,
    ): Promise<Pick<BranchSnapshot, "upstreamBranchId" | "generation" | "state"> | null>;
  };
  branchRows?: {
    listJournalRowsForBranch(input: {
      branchId: string;
      generation: number;
    }): Promise<BranchJournalRow[]>;
  };
}): Promise<BranchReversalScope | null> {
  if (!input.branches.getBranch || !input.branchRows) {
    throw new Error("Branch reversal history is unavailable");
  }
  const peer = await input.branches.resolveThreadBranch(input.documentId, input.threadId);
  peer.doc.destroy();
  const peerSnapshot = await input.branches.getBranch(peer.branchId);
  if (!peerSnapshot?.upstreamBranchId) return null;
  const workDraft = await input.branches.getBranch(peerSnapshot.upstreamBranchId);
  if (!workDraft) return null;
  const rows = (
    await input.branchRows.listJournalRowsForBranch({
      branchId: peerSnapshot.upstreamBranchId,
      generation: workDraft.generation,
    })
  ).sort((left, right) => left.id - right.id);
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
        state: workDraft.state,
        rows,
      }
    : null;
}

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

export type BranchReversalState = {
  activeWrites: ActiveWriteSummary[];
  mutationsByHandle: Map<string, WriteMutationRow[]>;
  reversals: ReversalRecord[];
  operationHandles: Array<{ seq: number; handles: string[] }>;
};

export function groupedOrdinalKey(documentId: string, threadId: string, groupId: string): string {
  return `${documentId}:${threadId}:${groupId}`;
}

export function stageBranchReversal(input: {
  pending: { push(entry: JournalBatchAppendEntry): void } | undefined;
  docId: string;
  threadId: ThreadId;
  scope: BranchReversalScope;
  expectedJournalWatermark: number;
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
      branchJournalWatermark: Number.isFinite(input.expectedJournalWatermark)
        ? input.expectedJournalWatermark
        : 0,
      branchJournalRevision: branchJournalRevision(input.scope.rows),
      actorKind: "system",
      threadId: input.threadId,
      turnId,
      systemOrigin: input.operation.direction,
      ...(authoringResponseId ? { authoringResponseId } : {}),
    },
  });
}

export function serializeBranchReversalRecord(
  record: ReversalRecord,
): SerializedBranchReversalRecord {
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

  for (const row of [...rows].sort((left, right) => left.id - right.id)) {
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

export function buildBranchReversalState(
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

export function branchRowAsPersistedUpdate(row: BranchJournalRow): PersistedUpdate {
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
      ...(stored.reversalActor ? { reversalActor: stored.reversalActor } : {}),
    },
  };
}

export function materializeSnapshot(snapshot: JournalSnapshot): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
