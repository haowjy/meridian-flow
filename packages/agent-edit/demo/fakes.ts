// In-memory fake server ports for the throwaway agent-edit demo harness.
import {
  type CompactionResult,
  type DocumentCoordinator,
  type DocumentLifecycle,
  DocumentNotFoundError,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalSnapshot,
  type MutationStore,
  type PersistedUpdate,
  type ReversalRecord,
  type ReversalStatus,
  type UpdateJournal,
  type UpdateMeta,
} from "@meridian/agent-edit";
import * as Y from "yjs";

interface StoredUpdate extends PersistedUpdate {
  storedAt: Date;
}

interface StoredReversal {
  record: ReversalRecord;
  storedAt: Date;
}

interface StoredMutation {
  wId: number;
  documentId: string;
  threadId: string;
  turnId: string;
  status: "active" | "reversed";
  createdSeq: number;
  undoUpdateSeq?: number;
  createdAt: Date;
  reversedAt?: Date;
  reversedBy?: "user" | "agent";
}

interface JournalEntry {
  checkpoint: Uint8Array | null;
  updates: StoredUpdate[];
  nextSeq: number;
  reversals: Map<string, StoredReversal>;
  mutations: StoredMutation[];
}

const EMPTY_UPDATE_LENGTH = 2;

export class InMemoryJournal implements UpdateJournal, MutationStore {
  private readonly data = new Map<string, JournalEntry>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
    return this.appendInternal(docId, update, meta, this.now());
  }

  async appendBatch(
    entries: readonly JournalBatchAppendEntry[],
  ): Promise<JournalBatchAppendResult[]> {
    const storedAt = this.now();
    const nextSeqByDoc = new Map<string, number>();
    for (const batchEntry of entries) {
      const nextSeq = nextSeqByDoc.get(batchEntry.docId) ?? this.entry(batchEntry.docId).nextSeq;
      if (batchEntry.meta.seq !== 0 && batchEntry.meta.seq !== nextSeq) {
        throw new Error(`Expected seq ${nextSeq}, got ${batchEntry.meta.seq}`);
      }
      nextSeqByDoc.set(batchEntry.docId, nextSeq + 1);
    }
    return entries.map((batchEntry) => {
      const seq = this.appendInternal(
        batchEntry.docId,
        batchEntry.update,
        batchEntry.meta,
        storedAt,
      );
      if (!batchEntry.mutation) return { seq };
      const wId = this.appendMutationInternal(
        batchEntry.docId,
        batchEntry.mutation.threadId,
        batchEntry.mutation.turnId,
        seq,
        storedAt,
      );
      return { seq, wId };
    });
  }

  async read(
    docId: string,
    opts: { since?: number; until?: number } = {},
  ): Promise<JournalSnapshot> {
    const entry = this.entry(docId);
    const updates = entry.updates
      .filter(
        (update) =>
          (opts.since === undefined || update.seq >= opts.since) &&
          (opts.until === undefined || update.seq <= opts.until),
      )
      .sort((left, right) => left.seq - right.seq)
      .map(stripStoredFields);

    return {
      checkpoint: entry.checkpoint ? copyBytes(entry.checkpoint) : null,
      updates,
    };
  }

  async checkpoint(docId: string, state: Uint8Array): Promise<void> {
    this.entry(docId).checkpoint = copyBytes(state);
  }

  async compact(docId: string, before: Date): Promise<CompactionResult> {
    const entry = this.entry(docId);
    const foldable = entry.updates.filter((update) => update.storedAt < before);
    const foldedSeqs = new Set(foldable.map((update) => update.seq));

    if (foldable.length > 0) {
      const doc = new Y.Doc({ gc: false });
      if (entry.checkpoint) Y.applyUpdate(doc, entry.checkpoint);
      for (const update of foldable.sort((left, right) => left.seq - right.seq)) {
        Y.applyUpdate(doc, update.update);
      }
      entry.checkpoint = Y.encodeStateAsUpdate(doc);
      entry.updates = entry.updates.filter((update) => !foldedSeqs.has(update.seq));
    }

    let reversalsExpired = 0;
    for (const stored of entry.reversals.values()) {
      const shouldExpire =
        foldedSeqs.has(stored.record.undoUpdateSeq) ||
        (stored.record.expiresAt !== undefined && stored.record.expiresAt <= before);
      if (!shouldExpire || stored.record.status === "expired") continue;
      stored.record = { ...stored.record, status: "expired" };
      reversalsExpired += 1;
    }

    return { updatesFolded: foldable.length, reversalsExpired };
  }

  async persistReversal(
    docId: string,
    undoUpdate: Uint8Array,
    record: ReversalRecord,
  ): Promise<void> {
    const storedAt = this.now();
    const seq = this.appendInternal(docId, undoUpdate, { origin: "system", seq: 0 }, storedAt);
    record.undoUpdateSeq = seq;

    const entry = this.entry(docId);
    entry.reversals.set(reversalKey(docId, record.threadId, record.turnId), {
      record: { ...record, undoUpdateSeq: seq },
      storedAt,
    });
    this.reverseMutations(
      docId,
      record.threadId,
      record.turnId,
      seq,
      record.reversedAt ?? storedAt,
    );
  }

  async persistRedo(
    docId: string,
    redoUpdate: Uint8Array,
    ref: { threadId: string; turnId: string },
    meta: UpdateMeta,
  ): Promise<{ consumed: boolean; seq?: number }> {
    const key = reversalKey(docId, ref.threadId, ref.turnId);
    const stored = this.entry(docId).reversals.get(key);
    if (stored?.record.status !== "reversed") return { consumed: false };

    const storedAt = this.now();
    const seq = this.appendInternal(docId, redoUpdate, meta, storedAt);
    this.entry(docId).reversals.set(key, {
      ...stored,
      record: { ...stored.record, status: "redone" },
    });
    this.reactivateMutations(docId, ref.threadId, ref.turnId);
    return { consumed: true, seq };
  }

  async readReversals(
    docId: string,
    opts: { threadId?: string; status?: ReversalStatus[] } = {},
  ): Promise<ReversalRecord[]> {
    return [...this.entry(docId).reversals.values()]
      .map((stored) => stored.record)
      .filter(
        (record) =>
          (opts.threadId === undefined || record.threadId === opts.threadId) &&
          (opts.status === undefined || opts.status.includes(record.status)),
      )
      .map((record) => ({ ...record }));
  }

  async latestActiveTurn(documentId: string, threadId: string): Promise<string | undefined> {
    return this.entry(documentId)
      .mutations.filter((record) => record.threadId === threadId && record.status === "active")
      .sort((left, right) => left.createdSeq - right.createdSeq)
      .at(-1)?.turnId;
  }

  async activeTurnSummary(
    documentId: string,
    threadId: string,
  ): Promise<Array<{ turnId: string; count: number; minSeq: number }>> {
    const byTurn = new Map<string, { turnId: string; count: number; minSeq: number }>();
    for (const record of this.entry(documentId).mutations) {
      if (record.threadId !== threadId || record.status !== "active") continue;
      const existing = byTurn.get(record.turnId);
      if (existing) {
        existing.count += 1;
        existing.minSeq = Math.min(existing.minSeq, record.createdSeq);
      } else {
        byTurn.set(record.turnId, {
          turnId: record.turnId,
          count: 1,
          minSeq: record.createdSeq,
        });
      }
    }
    return [...byTurn.values()].sort((left, right) => left.minSeq - right.minSeq);
  }

  reversalRecords(docId: string): ReversalRecord[] {
    return [...this.entry(docId).reversals.values()].map((stored) => ({ ...stored.record }));
  }

  mutationRecords(docId: string): StoredMutation[] {
    return this.entry(docId).mutations.map((record) => ({ ...record }));
  }

  private appendInternal(
    docId: string,
    update: Uint8Array,
    meta: UpdateMeta,
    storedAt: Date,
  ): number {
    const entry = this.entry(docId);
    const seq = entry.nextSeq;
    if (meta.seq !== 0 && meta.seq !== seq) {
      throw new Error(`Expected seq ${seq}, got ${meta.seq}`);
    }

    entry.nextSeq += 1;
    entry.updates.push({
      seq,
      update: copyBytes(update),
      meta: { ...meta, seq },
      storedAt,
    });
    return seq;
  }

  private appendMutationInternal(
    docId: string,
    threadId: string,
    turnId: string,
    createdSeq: number,
    createdAt: Date,
  ): number {
    const entry = this.entry(docId);
    const wId =
      Math.max(
        0,
        ...entry.mutations
          .filter((record) => record.documentId === docId && record.threadId === threadId)
          .map((record) => record.wId),
      ) + 1;
    entry.mutations.push({
      wId,
      documentId: docId,
      threadId,
      turnId,
      status: "active",
      createdSeq,
      createdAt,
    });
    return wId;
  }

  private reverseMutations(
    docId: string,
    threadId: string,
    turnId: string,
    undoUpdateSeq: number,
    reversedAt: Date,
  ): void {
    for (const record of this.entry(docId).mutations) {
      if (record.threadId !== threadId || record.turnId !== turnId) continue;
      record.status = "reversed";
      record.undoUpdateSeq = undoUpdateSeq;
      record.reversedAt = reversedAt;
      record.reversedBy = "agent";
    }
  }

  private reactivateMutations(docId: string, threadId: string, turnId: string): void {
    for (const record of this.entry(docId).mutations) {
      if (record.threadId !== threadId || record.turnId !== turnId) continue;
      record.status = "active";
      delete record.undoUpdateSeq;
      delete record.reversedAt;
      delete record.reversedBy;
    }
  }

  private entry(docId: string): JournalEntry {
    let entry = this.data.get(docId);
    if (!entry) {
      entry = { checkpoint: null, updates: [], nextSeq: 1, reversals: new Map(), mutations: [] };
      this.data.set(docId, entry);
    }
    return entry;
  }
}

export class InMemoryCoordinator implements DocumentCoordinator, DocumentLifecycle {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly locks = new Map<string, Promise<void>>();
  private nextClientId = 1000;

  constructor(private readonly journal: UpdateJournal) {}

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    return this.lock(docId, async () => fn(this.getOrCreate(docId)));
  }

  async recover(docId: string): Promise<void> {
    await this.withDocument(docId, async (doc) => {
      const snapshot = await this.journal.read(docId);
      if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
      for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
    });
  }

  async ensureDocument(docId: string): Promise<void> {
    this.getOrCreate(docId);
  }

  requireDocument(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new DocumentNotFoundError(docId);
    return doc;
  }

  async applyHumanUpdate(
    docId: string,
    userId: string,
    mutate: (doc: Y.Doc) => void,
  ): Promise<number | null> {
    return this.withDocument(docId, async (doc) => {
      const beforeVector = Y.encodeStateVector(doc);
      doc.transact(() => mutate(doc), { type: "human", userId });
      const update = Y.encodeStateAsUpdate(doc, beforeVector);
      if (!hasYjsUpdate(update)) return null;
      return this.journal.append(docId, update, { origin: `human:${userId}`, seq: 0 });
    });
  }

  private getOrCreate(docId: string): Y.Doc {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = new Y.Doc({ gc: false });
      doc.clientID = this.nextClientId;
      this.nextClientId += 1;
      this.docs.set(docId, doc);
    }
    return doc;
  }

  private async lock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(docId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(docId, tail);
    tail.finally(() => {
      if (this.locks.get(docId) === tail) this.locks.delete(docId);
    });
    return run;
  }
}

function stripStoredFields(update: StoredUpdate): PersistedUpdate {
  return {
    seq: update.seq,
    update: copyBytes(update.update),
    meta: { ...update.meta },
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function reversalKey(docId: string, threadId: string, turnId: string): string {
  return `${docId}\u0000${threadId}\u0000${turnId}`;
}

function hasYjsUpdate(update: Uint8Array): boolean {
  return update.length > EMPTY_UPDATE_LENGTH;
}
