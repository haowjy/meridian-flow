// Canonical in-memory agent-edit journal for tests.
import * as Y from "yjs";
import { type SavePrecondition, SavePreconditionRefused } from "../ports/document-coordinator.js";
import type { JournalSnapshot, PersistedUpdate, UpdateMeta } from "../ports/types.js";
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalReadOptions,
  UpdateJournal,
} from "../ports/update-journal.js";

export interface StoredCheckpoint {
  state: Uint8Array;
  upToSeq: number;
}

export interface JournalEntry {
  checkpoint: StoredCheckpoint | null;
  checkpoints: StoredCheckpoint[];
  nextSeq: number;
  nextWIdByThread: Map<string, number>;
  updates: PersistedUpdate[];
  turnsByThread: Map<string, Set<string>>;
}

/**
 * Drizzle-compatible in-memory implementation of UpdateJournal.
 *
 * This is deliberately shared by package tests and the server in-memory
 * adapter so write-ordinal allocation does not drift away from the
 * production adapter.
 */
export class InMemoryAgentEditJournal implements UpdateJournal {
  private readonly data = new Map<string, JournalEntry>();
  async append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
    return this.appendSync(docId, update, meta);
  }

  async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
    precondition?: SavePrecondition,
  ): Promise<JournalBatchAppendResult[]> {
    if (entries.length === 0) return [];

    const nextSeqByDoc = new Map<string, number>();
    for (const batchEntry of entries) {
      const nextSeq = nextSeqByDoc.get(batchEntry.docId) ?? this.entry(batchEntry.docId).nextSeq;
      assertExpectedSeq(batchEntry.meta, nextSeq);
      nextSeqByDoc.set(batchEntry.docId, nextSeq + 1);
    }

    const beforeStates = new Map<string, Uint8Array>();
    for (const { docId } of entries) {
      if (beforeStates.has(docId)) continue;
      const { checkpoint, updates } = this.readSync(docId);
      beforeStates.set(
        docId,
        Y.mergeUpdates([...(checkpoint ? [checkpoint] : []), ...updates.map((row) => row.update)]),
      );
    }
    for (const [docId, beforeState] of beforeStates)
      if (precondition && !precondition(beforeState)) throw new SavePreconditionRefused(docId);

    return entries.map((batchEntry) => {
      const seq = this.appendSync(batchEntry.docId, batchEntry.update, batchEntry.meta);
      const beforeState = beforeStates.get(batchEntry.docId) as Uint8Array;
      if (!batchEntry.mutation) return { seq, beforeState };
      const wId =
        batchEntry.mutation.wId ??
        this.reserveWriteOrdinalSync(batchEntry.docId, batchEntry.mutation.threadId);
      if (batchEntry.mutation.turnId) {
        const turns = this.entry(batchEntry.docId).turnsByThread;
        const threadTurns = turns.get(batchEntry.mutation.threadId) ?? new Set<string>();
        threadTurns.add(batchEntry.mutation.turnId);
        turns.set(batchEntry.mutation.threadId, threadTurns);
      }
      return { seq, wId, beforeState };
    });
  }

  async reserveWriteOrdinal(documentId: string, threadId: string): Promise<number> {
    return this.reserveWriteOrdinalSync(documentId, threadId);
  }

  async read(docId: string, opts: JournalReadOptions = {}): Promise<JournalSnapshot> {
    return this.readSync(docId, opts);
  }

  async readUpdates(docId: string, after: number, through: number): Promise<PersistedUpdate[]> {
    return this.entry(docId)
      .updates.filter((update) => update.seq > after && update.seq <= through)
      .sort((left, right) => left.seq - right.seq)
      .map(copyPersistedUpdate);
  }

  async checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void> {
    this.setCheckpoint(docId, state, upToSeq);
  }

  appendSync(
    docId: string,
    update: Uint8Array,
    meta: Omit<UpdateMeta, "seq"> & { seq?: number },
  ): number {
    const entry = this.entry(docId);
    const seq = entry.nextSeq;
    assertExpectedSeq(meta, seq);

    entry.nextSeq += 1;
    const stored = {
      seq,
      update: copyBytes(update),
      meta: { ...meta, seq },
    };
    entry.updates.push(stored);
    return seq;
  }

  readSync(docId: string, opts: JournalReadOptions = {}): JournalSnapshot {
    const entry = this.entry(docId);
    const bound =
      opts.since === undefined
        ? opts.until
        : Math.min(opts.until ?? Number.MAX_SAFE_INTEGER, opts.since - 1);
    const checkpoint =
      bound === undefined
        ? entry.checkpoint
        : entry.checkpoints
            .filter((cut) => cut.upToSeq <= bound)
            .sort((a, b) => a.upToSeq - b.upToSeq)
            .at(-1);
    const checkpointUpToSeq = checkpoint?.upToSeq ?? 0;
    return {
      checkpoint: checkpoint ? copyBytes(checkpoint.state) : null,
      updates: entry.updates
        .filter(
          (update) =>
            update.seq > checkpointUpToSeq &&
            (opts.since === undefined || update.seq >= opts.since) &&
            (opts.until === undefined || update.seq <= opts.until),
        )
        .sort((left, right) => left.seq - right.seq)
        .map(copyPersistedUpdate),
    };
  }

  snapshot(docId: string, opts: JournalReadOptions = {}): JournalSnapshot {
    return this.readSync(docId, opts);
  }

  setCheckpoint(docId: string, state: Uint8Array, upToSeq = 0): void {
    const entry = this.entry(docId);
    const checkpoint = { state: copyBytes(state), upToSeq };
    entry.checkpoint = checkpoint;
    entry.checkpoints.push(checkpoint);
  }

  clone(): InMemoryAgentEditJournal {
    return this.cloneInto(new InMemoryAgentEditJournal());
  }

  protected cloneInto<T extends InMemoryAgentEditJournal>(target: T): T {
    target.data.clear();
    for (const [docId, entry] of this.data) {
      target.data.set(docId, {
        checkpoint: entry.checkpoint
          ? { state: copyBytes(entry.checkpoint.state), upToSeq: entry.checkpoint.upToSeq }
          : null,
        checkpoints: entry.checkpoints.map((checkpoint) => ({
          state: copyBytes(checkpoint.state),
          upToSeq: checkpoint.upToSeq,
        })),
        nextSeq: entry.nextSeq,
        nextWIdByThread: new Map(entry.nextWIdByThread),
        updates: entry.updates.map((update) => ({
          seq: update.seq,
          update: copyBytes(update.update),
          meta: { ...update.meta },
        })),
        turnsByThread: new Map(
          [...entry.turnsByThread].map(([threadId, turns]) => [threadId, new Set(turns)]),
        ),
      });
    }
    return target;
  }

  updateRecords(docId: string): PersistedUpdate[] {
    return this.entry(docId).updates.map(copyPersistedUpdate);
  }

  documentsForTurn(threadId: string, turnId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.data]
        .filter(([, entry]) => entry.turnsByThread.get(threadId)?.has(turnId))
        .map(([id]) => id)
        .sort(),
    );
  }

  debugEntry(docId: string): JournalEntry | undefined {
    return this.data.get(docId);
  }

  private reserveWriteOrdinalSync(docId: string, threadId: string): number {
    const entry = this.entry(docId);
    const wId = entry.nextWIdByThread.get(threadId) ?? 1;
    entry.nextWIdByThread.set(threadId, wId + 1);
    return wId;
  }

  private entry(docId: string): JournalEntry {
    let entry = this.data.get(docId);
    if (!entry) {
      entry = {
        checkpoint: null,
        checkpoints: [],
        nextSeq: 1,
        nextWIdByThread: new Map(),
        updates: [],
        turnsByThread: new Map(),
      };
      this.data.set(docId, entry);
    }
    return entry;
  }
}

function assertExpectedSeq(meta: { seq?: number }, expectedSeq: number): void {
  if (meta.seq !== undefined && meta.seq !== 0 && meta.seq !== expectedSeq) {
    throw new Error(`Expected seq ${expectedSeq}, got ${meta.seq}`);
  }
}

function copyPersistedUpdate(update: PersistedUpdate): PersistedUpdate {
  return {
    seq: update.seq,
    update: copyBytes(update.update),
    meta: { ...update.meta },
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
