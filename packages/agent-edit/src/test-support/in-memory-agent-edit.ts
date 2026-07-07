// Canonical in-memory agent-edit journal for tests and demos.
import * as Y from "yjs";
import type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalActor,
  ReversalRecord,
  ReversalStatus,
  UpdateMeta,
} from "../ports/types.js";
import type {
  ActiveWriteSummary,
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalReadOptions,
  PersistUndoResult,
  ReversalStore,
  UpdateJournal,
  WriteMutationRow,
} from "../ports/update-journal.js";
import { parseWriteHandle, writeHandle } from "../ports/update-journal.js";
import { guardPersistUndo } from "../undo/persist-undo-guard.js";

export type StoredAgentEditMutation = {
  wId: number;
  documentId: string;
  threadId: string;
  turnId: string | null;
  writeId: string;
  status: "active" | "reversed";
  createdSeq: number;
  undoUpdateSeq?: number;
  createdAt: Date;
  reversedAt?: Date;
  reversedBy?: "user" | "agent";
};

export interface InMemoryAgentEditJournalOptions {
  now?: () => Date;
}

export interface StoredUpdate extends PersistedUpdate {
  storedAt: Date;
}

export interface StoredReversal {
  record: ReversalRecord;
  createdAt: Date;
}

export interface StoredReversalOp {
  documentId: string;
  threadId: string;
  updateSeq: number;
  handle: string;
  direction: "undo" | "redo";
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
  reversals: Map<string, StoredReversal>;
  reversalOps: StoredReversalOp[];
  mutations: StoredAgentEditMutation[];
}

/**
 * Drizzle-compatible in-memory implementation of UpdateJournal.
 *
 * This is deliberately shared by package tests, demos, and the server in-memory
 * adapter so reversal metadata, w-id allocation, and compaction semantics do not
 * drift away from the production adapter.
 */
export class InMemoryAgentEditJournal implements UpdateJournal, ReversalStore {
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

    return entries.map((batchEntry) => {
      const seq = this.appendSync(
        batchEntry.docId,
        batchEntry.update,
        batchEntry.meta,
        storedAt,
        batchEntry.mutation?.updateKind,
      );
      if (!batchEntry.mutation) return { seq };
      const wId = this.appendMutationSync(
        batchEntry.docId,
        batchEntry.mutation.threadId,
        batchEntry.mutation.turnId,
        batchEntry.mutation.writeId ??
          `${batchEntry.mutation.threadId}:${batchEntry.mutation.turnId}:${seq}`,
        batchEntry.mutation.wId ??
          this.reserveWriteOrdinalSync(batchEntry.docId, batchEntry.mutation.threadId),
        seq,
        storedAt,
      );
      return { seq, wId };
    });
  }

  async reserveWriteOrdinal(documentId: string, threadId: string): Promise<number> {
    return this.reserveWriteOrdinalSync(documentId, threadId);
  }

  async read(docId: string, opts: JournalReadOptions = {}): Promise<JournalSnapshot> {
    return this.readSync(docId, opts);
  }

  async readForReconstruction(docId: string): Promise<JournalSnapshot> {
    return this.readSync(docId, { fromCheckpoint: false });
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
      entry.reversalOps = entry.reversalOps.filter((op) => op.updateSeq > compactedThroughSeq);
    }

    let reversalsExpired = 0;
    for (const stored of entry.reversals.values()) {
      const shouldExpire =
        stored.createdAt < before ||
        (stored.record.expiresAt !== undefined && stored.record.expiresAt < before);
      if (!shouldExpire || stored.record.status === "expired") continue;
      stored.record = { ...stored.record, status: "expired" };
      reversalsExpired += 1;
    }

    return { updatesFolded: foldRows.length, reversalsExpired };
  }

  async persistUndo(
    docId: string,
    undoUpdate: Uint8Array,
    records: readonly ReversalRecord[],
    actor: ReversalActor = { type: "agent" },
  ): Promise<PersistUndoResult> {
    const blocked = await guardPersistUndo(this, docId, records);
    if (blocked) return blocked;

    const storedAt = this.now();
    const seq = this.appendSync(docId, undoUpdate, { origin: "system", seq: 0 }, storedAt);

    const entry = this.entry(docId);
    for (const record of records) {
      for (const writeId of record.writeIds) {
        const key = reversalKey(docId, record.threadId, writeId);
        const existing = entry.reversals.get(key);
        entry.reversals.set(key, {
          record: copyReversalRecord({
            ...record,
            documentId: docId,
            writeIds: [writeId],
            undoUpdateSeq: seq,
            redoUpdateSeq: undefined,
          }),
          createdAt: existing ? copyDate(existing.createdAt) : copyDate(storedAt),
        });
        entry.reversalOps.push({
          documentId: docId,
          threadId: record.threadId,
          updateSeq: seq,
          handle: writeId,
          direction: "undo",
        });
        this.reverseMutations(
          docId,
          record.threadId,
          writeId,
          seq,
          record.reversedAt ?? storedAt,
          actor,
        );
      }
    }
    return { persisted: true };
  }

  async persistReversal(
    docId: string,
    undoUpdate: Uint8Array,
    record: ReversalRecord,
  ): Promise<void> {
    await this.persistUndo(docId, undoUpdate, [record]);
  }

  async persistRedo(
    docId: string,
    redoUpdate: Uint8Array,
    ref: { threadId: string; undoUpdateSeq: number },
    meta: UpdateMeta,
  ): Promise<{ consumed: boolean; seq?: number }> {
    const entry = this.entry(docId);
    const group = [...entry.reversals.entries()].filter(
      ([, stored]) =>
        stored.record.threadId === ref.threadId &&
        stored.record.undoUpdateSeq === ref.undoUpdateSeq,
    );
    if (group.length === 0 || group.some(([, stored]) => stored.record.status !== "reversed")) {
      return { consumed: false };
    }

    const seq = this.appendSync(docId, redoUpdate, meta, this.now());
    for (const [key, stored] of group) {
      entry.reversals.set(key, {
        ...stored,
        record: { ...stored.record, status: "redone", redoUpdateSeq: seq },
      });
      for (const writeId of stored.record.writeIds) {
        entry.reversalOps.push({
          documentId: docId,
          threadId: ref.threadId,
          updateSeq: seq,
          handle: writeId,
          direction: "redo",
        });
        this.reactivateMutations(docId, ref.threadId, writeId, ref.undoUpdateSeq);
      }
    }
    return { consumed: true, seq };
  }

  async readReversals(
    docId: string,
    opts: { threadId?: string; status?: ReversalStatus[] } = {},
  ): Promise<ReversalRecord[]> {
    if (opts.status !== undefined && opts.status.length === 0) return [];
    return [...this.entry(docId).reversals.values()]
      .map((stored) => stored.record)
      .filter(
        (record) =>
          (opts.threadId === undefined || record.threadId === opts.threadId) &&
          (opts.status === undefined || opts.status.includes(record.status)),
      )
      .sort(compareReversalRecords)
      .map(copyReversalRecord);
  }

  async reversalOpSeqsForHandles(
    docId: string,
    threadId: string,
    handles: readonly string[],
  ): Promise<Set<number>> {
    const handleSet = new Set(handles);
    return new Set(
      this.entry(docId)
        .reversalOps.filter((op) => op.threadId === threadId && handleSet.has(op.handle))
        .map((op) => op.updateSeq),
    );
  }

  async documentsForTurn(threadId: string, turnId: string): Promise<string[]> {
    const documentIds = new Set<string>();
    for (const [documentId, entry] of this.data) {
      if (
        entry.mutations.some(
          (mutation) => mutation.threadId === threadId && mutation.turnId === turnId,
        )
      ) {
        documentIds.add(documentId);
      }
    }
    return [...documentIds].sort();
  }

  async latestActiveWrite(
    documentId: string,
    threadId: string,
  ): Promise<ActiveWriteSummary | undefined> {
    const record = this.entry(documentId)
      .mutations.filter(
        (mutation) => mutation.threadId === threadId && mutation.status === "active",
      )
      .sort((left, right) => left.wId - right.wId)
      .at(-1);
    return record ? activeWriteSummary(record) : undefined;
  }

  async activeWriteSummary(documentId: string, threadId: string): Promise<ActiveWriteSummary[]> {
    return this.entry(documentId)
      .mutations.filter((record) => record.threadId === threadId && record.status === "active")
      .sort((left, right) => left.wId - right.wId)
      .map(activeWriteSummary);
  }

  async writeMinCreatedSeq(
    documentId: string,
    threadId: string,
    handle: string,
  ): Promise<number | undefined> {
    const ordinal = parseWriteHandle(handle);
    if (ordinal === undefined) return undefined;
    const seqs = this.entry(documentId)
      .mutations.filter((record) => record.threadId === threadId && record.wId === ordinal)
      .map((record) => record.createdSeq);
    return seqs.length > 0 ? Math.min(...seqs) : undefined;
  }

  async mutationsForWrite(
    documentId: string,
    threadId: string,
    handle: string,
  ): Promise<WriteMutationRow[]> {
    const ordinal = parseWriteHandle(handle);
    if (ordinal === undefined) return [];
    return this.entry(documentId)
      .mutations.filter((record) => record.threadId === threadId && record.wId === ordinal)
      .sort((left, right) => left.createdSeq - right.createdSeq || left.wId - right.wId)
      .map(writeMutationRow);
  }

  async mutationsForWrites(
    documentId: string,
    threadId: string,
    handles: readonly string[],
  ): Promise<Map<string, WriteMutationRow[]>> {
    const result = new Map<string, WriteMutationRow[]>();
    for (const handle of handles) {
      result.set(handle, await this.mutationsForWrite(documentId, threadId, handle));
    }
    return result;
  }

  appendSync(
    docId: string,
    update: Uint8Array,
    meta: Omit<UpdateMeta, "seq"> & { seq?: number },
    storedAt: Date = this.now(),
    updateKind?: string | null,
  ): number {
    const entry = this.entry(docId);
    const seq = entry.nextSeq;
    assertExpectedSeq(meta, seq);

    entry.nextSeq += 1;
    entry.updates.push({
      seq,
      update: copyBytes(update),
      meta: { ...meta, seq },
      ...(updateKind ? { updateKind } : {}),
      storedAt: copyDate(storedAt),
    });
    return seq;
  }

  readSync(
    docId: string,
    opts: JournalReadOptions & { fromCheckpoint?: boolean } = {},
  ): JournalSnapshot {
    const entry = this.entry(docId);
    const fromCheckpoint = opts.fromCheckpoint ?? true;
    const checkpoint = fromCheckpoint
      ? entry.checkpoint
      : this.selectReconstructionCheckpoint(entry, opts.until);
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
          ...(update.updateKind ? { updateKind: update.updateKind } : {}),
          storedAt: copyDate(update.storedAt),
        })),
        reversals: new Map(
          [...entry.reversals].map(([key, stored]) => [
            key,
            { record: copyReversalRecord(stored.record), createdAt: copyDate(stored.createdAt) },
          ]),
        ),
        reversalOps: entry.reversalOps.map((op) => ({ ...op })),
        mutations: entry.mutations.map(copyMutationRecord),
      });
    }
    return target;
  }

  updateRecords(docId: string): PersistedUpdate[] {
    return this.entry(docId).updates.map(copyPersistedUpdate);
  }

  reversalRecords(docId: string): ReversalRecord[] {
    return [...this.entry(docId).reversals.values()].map((stored) =>
      copyReversalRecord(stored.record),
    );
  }

  mutationRecords(docId: string): StoredAgentEditMutation[] {
    return this.entry(docId).mutations.map(copyMutationRecord);
  }

  debugEntry(docId: string): JournalEntry | undefined {
    return this.data.get(docId);
  }

  private selectReconstructionCheckpoint(
    entry: JournalEntry,
    untilSeq?: number,
  ): StoredCheckpoint | null {
    // Reconstruction must start from the newest checkpoint strictly BELOW the earliest
    // retained update needed for this read, then replay retained updates — never a
    // checkpoint at/above them, which would hide the rows undo and draft projection need.
    // Historical reads additionally must not choose a checkpoint above `untilSeq`, because
    // that checkpoint contains future live edits relative to the requested base.
    const relevantUpdates =
      untilSeq === undefined
        ? entry.updates
        : entry.updates.filter((update) => update.seq <= untilSeq);
    if (relevantUpdates.length === 0) return this.latestCheckpointAtOrBefore(entry, untilSeq);

    const minRetainedSeq = Math.min(...relevantUpdates.map((update) => update.seq));
    let selected: StoredCheckpoint | null = null;
    for (const checkpoint of entry.checkpoints) {
      if (checkpoint.upToSeq >= minRetainedSeq) continue;
      if (untilSeq !== undefined && checkpoint.upToSeq > untilSeq) continue;
      if (selected === null || checkpoint.upToSeq >= selected.upToSeq) selected = checkpoint;
    }
    // null when no checkpoint precedes the earliest retained update: reconstruct from an
    // empty base plus every retained update row.
    return selected;
  }

  private latestCheckpointAtOrBefore(
    entry: JournalEntry,
    untilSeq: number | undefined,
  ): StoredCheckpoint | null {
    let selected: StoredCheckpoint | null = null;
    for (const checkpoint of entry.checkpoints) {
      if (untilSeq !== undefined && checkpoint.upToSeq > untilSeq) continue;
      if (selected === null || checkpoint.upToSeq >= selected.upToSeq) selected = checkpoint;
    }
    return selected;
  }

  private appendMutationSync(
    docId: string,
    threadId: string,
    turnId: string | null,
    writeId: string,
    wId: number,
    createdSeq: number,
    createdAt: Date,
  ): number {
    const entry = this.entry(docId);
    entry.mutations.push({
      wId,
      documentId: docId,
      threadId,
      turnId,
      writeId,
      status: "active",
      createdSeq,
      createdAt: copyDate(createdAt),
    });
    return wId;
  }

  private reserveWriteOrdinalSync(docId: string, threadId: string): number {
    const entry = this.entry(docId);
    const wId = entry.nextWIdByThread.get(threadId) ?? 1;
    entry.nextWIdByThread.set(threadId, wId + 1);
    return wId;
  }

  private reverseMutations(
    docId: string,
    threadId: string,
    writeId: string,
    undoUpdateSeq: number,
    reversedAt: Date,
    actor: ReversalActor,
  ): void {
    for (const record of this.entry(docId).mutations) {
      if (record.threadId !== threadId || writeHandle(record.wId) !== writeId) continue;
      if (record.status !== "active") continue;
      record.status = "reversed";
      record.undoUpdateSeq = undoUpdateSeq;
      record.reversedAt = copyDate(reversedAt);
      record.reversedBy = actor.type;
    }
  }

  private reactivateMutations(
    docId: string,
    threadId: string,
    writeId: string,
    undoUpdateSeq: number,
  ): void {
    for (const record of this.entry(docId).mutations) {
      if (record.threadId !== threadId || writeHandle(record.wId) !== writeId) continue;
      if (record.status !== "reversed" || record.undoUpdateSeq !== undoUpdateSeq) continue;
      record.status = "active";
      delete record.undoUpdateSeq;
      delete record.reversedAt;
      delete record.reversedBy;
    }
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
        reversals: new Map(),
        reversalOps: [],
        mutations: [],
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

function reversalKey(docId: string, threadId: string, writeId: string): string {
  return `${docId}\u0000${threadId}\u0000${writeId}`;
}

function compareReversalRecords(left: ReversalRecord, right: ReversalRecord): number {
  const leftTime = left.reversedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = right.reversedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime || left.undoUpdateSeq - right.undoUpdateSeq;
}

function copyPersistedUpdate(update: PersistedUpdate): PersistedUpdate {
  return {
    seq: update.seq,
    update: copyBytes(update.update),
    meta: { ...update.meta },
    ...(update.updateKind ? { updateKind: update.updateKind } : {}),
  };
}

function copyReversalRecord(record: ReversalRecord): ReversalRecord {
  return {
    documentId: record.documentId,
    turnId: record.turnId,
    threadId: record.threadId,
    writeIds: [...record.writeIds],
    status: record.status,
    undoUpdateSeq: record.undoUpdateSeq,
    ...(record.redoUpdateSeq !== undefined ? { redoUpdateSeq: record.redoUpdateSeq } : {}),
    ...(record.expiresAt ? { expiresAt: copyDate(record.expiresAt) } : {}),
    ...(record.reversedAt ? { reversedAt: copyDate(record.reversedAt) } : {}),
    ...(record.reversedByUserId ? { reversedByUserId: record.reversedByUserId } : {}),
  };
}

function copyMutationRecord(record: StoredAgentEditMutation): StoredAgentEditMutation {
  return {
    wId: record.wId,
    documentId: record.documentId,
    threadId: record.threadId,
    turnId: record.turnId,
    writeId: record.writeId,
    status: record.status,
    createdSeq: record.createdSeq,
    createdAt: copyDate(record.createdAt),
    ...(record.undoUpdateSeq !== undefined ? { undoUpdateSeq: record.undoUpdateSeq } : {}),
    ...(record.reversedAt ? { reversedAt: copyDate(record.reversedAt) } : {}),
    ...(record.reversedBy ? { reversedBy: record.reversedBy } : {}),
  };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function copyDate(date: Date): Date {
  return new Date(date.getTime());
}

function activeWriteSummary(record: StoredAgentEditMutation): ActiveWriteSummary {
  return {
    writeId: record.writeId,
    handle: writeHandle(record.wId),
    wId: record.wId,
    turnId: record.turnId,
    createdSeq: record.createdSeq,
  };
}

function writeMutationRow(record: StoredAgentEditMutation): WriteMutationRow {
  return {
    writeId: record.writeId,
    handle: writeHandle(record.wId),
    wId: record.wId,
    turnId: record.turnId,
    createdSeq: record.createdSeq,
    status: record.status,
    ...(record.undoUpdateSeq !== undefined ? { undoUpdateSeq: record.undoUpdateSeq } : {}),
  };
}
