/**
 * In-memory implementation of the collab DocumentStore port. Owns Map/array
 * state mirroring the persisted tables (heads, updates, checkpoints, restore
 * points) with defensive byte cloning. Used by tests and local dev; depends
 * inward on the port only.
 */
import type {
  AppendUpdateInput,
  CheckpointRow,
  CompactDocumentLogInput,
  DocumentStore,
  HeadRow,
  InsertCheckpointInput,
  InsertRestorePointInput,
  RestorePointRow,
  UpdateRow,
} from "../../ports/document-store.js";

interface State {
  heads: Map<string, HeadRow>;
  updates: UpdateRow[];
  checkpoints: CheckpointRow[];
  restorePoints: RestorePointRow[];
  updateSeq: number;
  checkpointSeq: number;
  restoreSeq: number;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneHead(head: HeadRow): HeadRow {
  return {
    ...head,
    latestStateVector: head.latestStateVector ? cloneBytes(head.latestStateVector) : null,
  };
}

function cloneUpdate(update: UpdateRow): UpdateRow {
  return {
    ...update,
    updateData: cloneBytes(update.updateData),
  };
}

function cloneCheckpoint(checkpoint: CheckpointRow): CheckpointRow {
  return {
    ...checkpoint,
    state: cloneBytes(checkpoint.state),
    stateVector: cloneBytes(checkpoint.stateVector),
  };
}

/**
 * In-memory {@link DocumentStore} for tests. Mirrors the drizzle adapter's
 * sequencing: update seqs and checkpoint ids come from monotonic counters.
 */
export function createInMemoryDocumentStore(): DocumentStore {
  let state: State = {
    heads: new Map(),
    updates: [],
    checkpoints: [],
    restorePoints: [],
    updateSeq: 0,
    checkpointSeq: 0,
    restoreSeq: 0,
  };

  function now(): string {
    return new Date().toISOString();
  }

  function cloneState(source: State): State {
    return {
      heads: new Map([...source.heads].map(([id, head]) => [id, cloneHead(head)])),
      updates: source.updates.map(cloneUpdate),
      checkpoints: source.checkpoints.map(cloneCheckpoint),
      restorePoints: source.restorePoints.map((restorePoint) => ({ ...restorePoint })),
      updateSeq: source.updateSeq,
      checkpointSeq: source.checkpointSeq,
      restoreSeq: source.restoreSeq,
    };
  }

  function createStore(getState: () => State, commitState: (next: State) => void): DocumentStore {
    return {
      async transaction<T>(fn: (store: DocumentStore) => Promise<T>): Promise<T> {
        let transactionState = cloneState(getState());
        const result = await fn(
          createStore(
            () => transactionState,
            (next) => {
              transactionState = next;
            },
          ),
        );
        commitState(transactionState);
        return result;
      },

      async getHead(documentId) {
        const head = getState().heads.get(documentId);
        return head ? cloneHead(head) : null;
      },

      async upsertHead(head) {
        getState().heads.set(head.documentId, cloneHead(head));
      },

      async appendUpdate(input: AppendUpdateInput) {
        const current = getState();
        current.updateSeq += 1;
        current.updates.push({
          seq: current.updateSeq,
          documentId: input.documentId,
          updateData: cloneBytes(input.updateData),
          originType: input.originType,
          actorUserId: input.actorUserId,
          actorAgentRunId: input.actorAgentRunId,
          actorTurnId: input.actorTurnId,
          createdAt: now(),
        });
        return current.updateSeq;
      },

      async countUpdatesAfter(documentId, afterSeq) {
        return getState().updates.filter((u) => u.documentId === documentId && u.seq > afterSeq)
          .length;
      },

      async listUpdatesAfter(documentId, afterSeq) {
        return getState()
          .updates.filter((u) => u.documentId === documentId && u.seq > afterSeq)
          .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
          .map(cloneUpdate);
      },

      async insertCheckpoint(input: InsertCheckpointInput) {
        const current = getState();
        current.checkpointSeq += 1;
        current.checkpoints.push({
          id: current.checkpointSeq,
          documentId: input.documentId,
          state: cloneBytes(input.state),
          stateVector: cloneBytes(input.stateVector),
          upToSeq: input.upToSeq,
          reason: input.reason,
          createdAt: now(),
        });
        return current.checkpointSeq;
      },

      async getLatestCheckpoint(documentId) {
        let latest: CheckpointRow | null = null;
        for (const c of getState().checkpoints) {
          if (c.documentId !== documentId) continue;
          if (!latest || c.id > latest.id) latest = c;
        }
        return latest ? cloneCheckpoint(latest) : null;
      },

      async getCheckpoint(checkpointId) {
        const found = getState().checkpoints.find((c) => c.id === checkpointId);
        return found ? cloneCheckpoint(found) : null;
      },

      async listCheckpoints(documentId) {
        return getState()
          .checkpoints.filter((c) => c.documentId === documentId)
          .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
          .map(cloneCheckpoint);
      },

      async insertRestorePoint(input: InsertRestorePointInput) {
        const current = getState();
        current.restoreSeq += 1;
        const row: RestorePointRow = {
          id: `rp_${current.restoreSeq}`,
          documentId: input.documentId,
          name: input.name,
          checkpointId: input.checkpointId,
          upToSeq: input.upToSeq,
          createdByUserId: input.createdByUserId,
          createdAt: now(),
        };
        current.restorePoints.push(row);
        return { ...row };
      },

      async listRestorePoints(documentId) {
        return getState()
          .restorePoints.filter((r) => r.documentId === documentId)
          .reverse()
          .map((r) => ({ ...r }));
      },

      async getRestorePoint(id) {
        const found = getState().restorePoints.find((r) => r.id === id);
        return found ? { ...found } : null;
      },

      async compactDocumentLog(input: CompactDocumentLogInput) {
        const keepCheckpointIds = new Set(input.keepCheckpointIds);
        const current = getState();

        for (let i = current.updates.length - 1; i >= 0; i -= 1) {
          const update = current.updates[i];
          if (
            update.documentId === input.documentId &&
            update.seq <= input.pruneUpdatesThroughSeq &&
            update.createdAt < input.pruneRowsCreatedBefore
          ) {
            current.updates.splice(i, 1);
          }
        }

        for (let i = current.checkpoints.length - 1; i >= 0; i -= 1) {
          const checkpoint = current.checkpoints[i];
          if (
            checkpoint.documentId === input.documentId &&
            checkpoint.upToSeq <= input.pruneCheckpointsThroughSeq &&
            checkpoint.createdAt < input.pruneRowsCreatedBefore &&
            !keepCheckpointIds.has(checkpoint.id)
          ) {
            current.checkpoints.splice(i, 1);
          }
        }
      },
    };
  }

  return createStore(
    () => state,
    (next) => {
      state = next;
    },
  );
}
