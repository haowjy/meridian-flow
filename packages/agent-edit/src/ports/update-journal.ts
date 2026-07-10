import type {
  CompactionResult,
  JournalSnapshot,
  ReversalActor,
  ReversalRecord,
  UpdateMeta,
} from "./types.js";

export type JournalCommitKind = "durable" | "staged";

type JournalMutationBase = {
  threadId: string;
  turnId: string | null;
  /** Stable write attempt id; provider tool ids are scoped by response/turn before persistence. */
  writeId?: string;
  /** Pre-reserved durable ordinal rendered as w<N>. */
  wId?: number;
  actorKind: "agent" | "human" | "system";
  userId?: string;
  systemOrigin?: string;
};

export type JournalMutation = JournalMutationBase &
  (
    | { mode: "live" }
    | {
        mode: "threadPeer";
        /** Host branch generation captured with the write baseline. */
        branchGeneration: number;
      }
  );

export interface JournalBatchAppendEntry {
  docId: string;
  update: Uint8Array;
  meta: UpdateMeta;
  /** Present for agent edit writes that need durable per-write metadata. */
  mutation?: JournalMutation;
}

export interface JournalBatchAppendResult {
  seq: number;
  /** Whether this append created durable truth, or only queued pending branch state. */
  journalCommitKind: JournalCommitKind;
  /** Durable monotonic ordinal per (documentId, threadId), present only for mutation entries. */
  wId?: number;
}

export interface ActiveWriteSummary {
  writeId: string;
  handle: string;
  wId: number;
  turnId: string | null;
  createdSeq: number;
}

export interface WriteMutationRow {
  writeId: string;
  handle: string;
  wId: number;
  turnId: string | null;
  createdSeq: number;
  status: "active" | "reversed";
  undoUpdateSeq?: number;
}

/**
 * Failure outcome returned by `ReversalStore.persistUndo` when a later live
 * journal row depends on the writes being undone. The unavoidable dependency
 * between the dropped writes and the surviving later edits makes the undo
 * lossy, so the persistence layer rejects instead of silently dropping the
 * undo bytes.
 *
 * The dependency check is performed inside the persistence transaction (after
 * the document mutation advisory lock) so the verdict is authoritative — no
 * caller-derived watermark can be racy, and the optional `guard` parameter
 * that previously thread-served that race is gone.
 */
export type PersistUndoResult =
  | { persisted: true }
  | { persisted: false; status: "cant_undo_dependent"; message?: string };

export interface PersistRedoEntry {
  update: Uint8Array;
  ref: { threadId: string; undoUpdateSeq: number };
  meta: UpdateMeta;
}

export interface JournalReadOptions {
  since?: number;
  until?: number;
}

/** Ordered Yjs update log: append/read/checkpoint/compact only. */
export interface UpdateJournal {
  append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number>;
  /** Append multiple Yjs updates in one all-or-nothing transaction. */
  appendBatch(entries: readonly JournalBatchAppendEntry[]): Promise<JournalBatchAppendResult[]>;
  read(docId: string, opts?: JournalReadOptions): Promise<JournalSnapshot>;
  checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void>;
  compact(docId: string, before: Date): Promise<CompactionResult>;
}

/** Write-level reversal store: write ordinals, mutation metadata, and undo/redo rows. */
export interface ReversalStore {
  /** Reserve the next durable per-(document, thread) write ordinal. */
  reserveWriteOrdinal(documentId: string, threadId: string): Promise<number>;
  /**
   * Earliest reconstructable base: the newest checkpoint strictly below the
   * earliest retained update row, plus the retained updates after it.
   * Reconstruction replays only update rows that still exist; a compacted prefix
   * is read from the compacted checkpoint, not the original baseline.
   */
  readForReconstruction(docId: string): Promise<JournalSnapshot>;
  /** Distinct documents touched by a thread turn. */
  documentsForTurn(threadId: string, turnId: string): Promise<string[]>;
  /** Latest active write for this document/thread, if one exists. */
  latestActiveWrite(documentId: string, threadId: string): Promise<ActiveWriteSummary | undefined>;
  /** Active writes in durable write order. */
  activeWriteSummary(documentId: string, threadId: string): Promise<ActiveWriteSummary[]>;
  /** Earliest forward journal sequence for this write, regardless of current mutation status. */
  writeMinCreatedSeq(
    documentId: string,
    threadId: string,
    handle: string,
  ): Promise<number | undefined>;
  /** Concrete mutation rows for one document/thread/write handle, used to target cold reconstruction. */
  mutationsForWrite(
    documentId: string,
    threadId: string,
    handle: string,
  ): Promise<WriteMutationRow[]>;
  /** Batched version — fetches mutation rows for multiple handles in one query. */
  mutationsForWrites(
    documentId: string,
    threadId: string,
    handles: readonly string[],
  ): Promise<Map<string, WriteMutationRow[]>>;
  persistUndo(
    docId: string,
    undoUpdate: Uint8Array,
    records: readonly ReversalRecord[],
    actor?: ReversalActor,
  ): Promise<PersistUndoResult>;
  persistRedo(
    docId: string,
    redoUpdate: Uint8Array,
    ref: { threadId: string; undoUpdateSeq: number },
    meta: UpdateMeta,
  ): Promise<{ consumed: boolean; seq?: number }>;
  /** Consume several redo groups in one persistence transaction. */
  persistRedoBatch(
    docId: string,
    entries: readonly PersistRedoEntry[],
  ): Promise<{ consumed: boolean; seqs?: number[] }>;
  readReversals(
    docId: string,
    opts?: { threadId?: string; status?: ReversalRecord["status"][] },
  ): Promise<ReversalRecord[]>;
  /** Every undo/redo system update seq ever written for these handles and still retained. */
  reversalOpSeqsForHandles(
    docId: string,
    threadId: string,
    handles: readonly string[],
  ): Promise<Set<number>>;
}

export function writeHandle(wId: number): string {
  return `w${wId}`;
}

export function parseWriteHandle(handle: string): number | undefined {
  if (!/^w[1-9]\d*$/.test(handle)) return undefined;
  const ordinal = Number(handle.slice(1));
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}
