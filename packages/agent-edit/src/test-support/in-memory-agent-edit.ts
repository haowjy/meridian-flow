// Canonical in-memory agent-edit journal for tests and demos.
import * as Y from "yjs";
import type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  UpdateMeta,
} from "../ports/types.js";
import type {
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalReadOptions,
  UpdateJournal,
} from "../ports/update-journal.js";

export interface InMemoryAgentEditJournalOptions {
  now?: () => Date;
}

export interface StoredUpdate extends PersistedUpdate {
  storedAt: Date;
}

export interface StoredCheckpoint {
  state: Uint8Array;
  upToSeq: number;
}

export interface JournalEntry {
  checkpoint: StoredCheckpoint | null;
  checkpoints: StoredCheckpoint[];
  nextSeq: number;
  nextWIdByThread: Map<string, number>;
  updates: StoredUpdate[];
  attributionUpdates: StoredUpdate[];
  turnsByThread: Map<string, Set<string>>;
}

/**
 * Drizzle-compatible in-memory implementation of UpdateJournal.
 *
 * This is deliberately shared by package tests, demos, and the server in-memory
 * adapter so write-ordinal allocation and compaction semantics do not
 * drift away from the production adapter.
 */
export class InMemoryAgentEditJournal implements UpdateJournal {
  private readonly data = new Map<string, JournalEntry>();
  private readonly now: () => Date;

  constructor(options: InMemoryAgentEditJournalOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
    return this.appendSync(docId, update, meta, this.now());
  }

  async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    if (entries.length === 0) return [];

    const storedAt = this.now();
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

    return entries.map((batchEntry) => {
      const seq = this.appendSync(batchEntry.docId, batchEntry.update, batchEntry.meta, storedAt);
      const beforeState = beforeStates.get(batchEntry.docId) as Uint8Array;
      if (!batchEntry.mutation) return { seq, journalCommitKind: "durable", beforeState };
      const wId =
        batchEntry.mutation.wId ??
        this.reserveWriteOrdinalSync(batchEntry.docId, batchEntry.mutation.threadId);
      if (batchEntry.mutation.turnId) {
        const turns = this.entry(batchEntry.docId).turnsByThread;
        const threadTurns = turns.get(batchEntry.mutation.threadId) ?? new Set<string>();
        threadTurns.add(batchEntry.mutation.turnId);
        turns.set(batchEntry.mutation.threadId, threadTurns);
      }
      return { seq, wId, journalCommitKind: "durable", beforeState };
    });
  }

  async reserveWriteOrdinal(documentId: string, threadId: string): Promise<number> {
    return this.reserveWriteOrdinalSync(documentId, threadId);
  }

  async read(docId: string, opts: JournalReadOptions = {}): Promise<JournalSnapshot> {
    return this.readSync(docId, opts);
  }

  async readAttribution(docId: string): Promise<JournalSnapshot> {
    return {
      checkpoint: null,
      updates: this.entry(docId).attributionUpdates.map(copyPersistedUpdate),
    };
  }

  async checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void> {
    this.setCheckpoint(docId, state, upToSeq);
  }

  async compact(docId: string, before: Date): Promise<CompactionResult> {
    const entry = this.entry(docId);
    const checkpointSeq = entry.checkpoint?.upToSeq ?? 0;
    // Compaction folds a contiguous seq prefix, so every retained update sits strictly
    // above the latest compacted checkpoint; reconstruction can safely start from the
    // newest checkpoint below the earliest retained update.
    const candidateRows = entry.updates
      .filter((update) => update.seq > checkpointSeq)
      .sort((left, right) => left.seq - right.seq);
    const firstRetainedIndex = candidateRows.findIndex((update) => update.storedAt >= before);
    const foldRows =
      firstRetainedIndex === -1 ? candidateRows : candidateRows.slice(0, firstRetainedIndex);

    let compactedThroughSeq = checkpointSeq;
    if (foldRows.length > 0) {
      const doc = new Y.Doc({ gc: false });
      if (entry.checkpoint) Y.applyUpdate(doc, entry.checkpoint.state);
      for (const row of foldRows) Y.applyUpdate(doc, row.update);
      compactedThroughSeq = foldRows.at(-1)?.seq ?? checkpointSeq;
      this.setCheckpoint(docId, Y.encodeStateAsUpdate(doc), compactedThroughSeq);
    }

    if (compactedThroughSeq > 0) {
      entry.updates = entry.updates.filter((update) => update.seq > compactedThroughSeq);
    }

    return { updatesFolded: foldRows.length };
  }

  appendSync(
    docId: string,
    update: Uint8Array,
    meta: Omit<UpdateMeta, "seq"> & { seq?: number },
    storedAt: Date = this.now(),
  ): number {
    const entry = this.entry(docId);
    const seq = entry.nextSeq;
    assertExpectedSeq(meta, seq);

    entry.nextSeq += 1;
    const stored = {
      seq,
      update: copyBytes(update),
      meta: { ...meta, seq },
      storedAt: copyDate(storedAt),
    };
    entry.updates.push(stored);
    entry.attributionUpdates.push({
      ...stored,
      update: copyBytes(stored.update),
      meta: { ...stored.meta },
      storedAt: copyDate(stored.storedAt),
    });
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
    return this.cloneInto(new InMemoryAgentEditJournal({ now: this.now }));
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
          storedAt: copyDate(update.storedAt),
        })),
        attributionUpdates: entry.attributionUpdates.map((update) => ({
          seq: update.seq,
          update: copyBytes(update.update),
          meta: { ...update.meta },
          storedAt: copyDate(update.storedAt),
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
        attributionUpdates: [],
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

function copyDate(date: Date): Date {
  return new Date(date.getTime());
}
