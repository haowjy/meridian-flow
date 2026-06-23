import type { CompactionResult, JournalSnapshot, ReversalRecord, UpdateMeta } from "./types.js";

export interface JournalBatchAppendEntry {
  docId: string;
  update: Uint8Array;
  meta: UpdateMeta;
  /** Present for agent edit writes that need a durable per-thread w-id. */
  mutation?: {
    threadId: string;
    turnId: string;
  };
}

export interface JournalBatchAppendResult {
  seq: number;
  /** Durable monotonic id per (documentId, threadId), present only for mutation entries. */
  wId?: number;
}

export interface ActiveTurnSummary {
  turnId: string;
  count: number;
  minSeq: number;
}

export interface TurnMutationRow {
  wId: number;
  createdSeq: number;
  status: "active" | "reversed";
  undoUpdateSeq?: number;
}

/**
 * Ordered Yjs update journal — the foundation every deployment implements.
 * Adapters guarantee durable append order, checkpoint storage, atomic reversal writes,
 * and mutation-query co-sourcing with the mutation rows created by appendBatch().
 */
export interface UpdateJournal {
  /**
   * Append a Yjs update with metadata (origin, turn, sequence).
   * Returns the assigned monotonic sequence number for this document.
   * Rejects when seq in meta does not match the next expected sequence.
   */
  append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number>;

  /**
   * Append multiple Yjs updates in one all-or-nothing transaction.
   * Returns assigned sequence numbers and mutation w-ids in the same order as entries.
   */
  appendBatch(entries: readonly JournalBatchAppendEntry[]): Promise<JournalBatchAppendResult[]>;

  /** Latest turn with active mutations for this document/thread, if one exists. */
  latestActiveTurn(documentId: string, threadId: string): Promise<string | undefined>;

  /** Active mutation counts and earliest retained sequence per turn. */
  activeTurnSummary(documentId: string, threadId: string): Promise<ActiveTurnSummary[]>;

  /** Earliest forward journal sequence for this turn, regardless of current mutation status. */
  turnMinCreatedSeq(
    documentId: string,
    threadId: string,
    turnId: string,
  ): Promise<number | undefined>;

  /** Concrete mutation rows for one document/thread/turn, used to target cold reconstruction. */
  mutationsForTurn(
    documentId: string,
    threadId: string,
    turnId: string,
  ): Promise<TurnMutationRow[]>;

  /**
   * Read checkpoint plus updates in sequence order.
   * When since/until are set, only updates with seq in [since, until] are included.
   * Returns an empty updates array when the document has no journal entries.
   */
  read(docId: string, opts?: { since?: number; until?: number }): Promise<JournalSnapshot>;

  /**
   * Write a checkpoint (full Y.Doc encoded state).
   * Replaces the previous checkpoint for this document; does not delete retained updates.
   *
   * upToSeq must be ≤ the updates reflected in state; excess replays are
   * idempotent, but claiming a higher seq would permanently skip updates.
   */
  checkpoint(docId: string, state: Uint8Array, upToSeq: number): Promise<void>;

  /**
   * Fold updates older than cutoff into a checkpoint and expire reversal records.
   * Returns counts of folded updates and expired reversals; does not mutate live Y.Docs.
   */
  compact(docId: string, before: Date): Promise<CompactionResult>;

  /**
   * Persist undo update bytes and reversal record in a single atomic transaction.
   * Both must land together or neither is visible to readers.
   */
  persistReversal(docId: string, undoUpdate: Uint8Array, record: ReversalRecord): Promise<void>;

  /**
   * Atomically consume a reversed record and append its redo update.
   * The reversal is scoped by document, thread, turn, and undo update sequence,
   * and the status guard runs in the same transaction as the append. If the
   * record is missing or is no longer "reversed", append nothing and report
   * that nothing was consumed.
   */
  persistRedo(
    docId: string,
    redoUpdate: Uint8Array,
    ref: { threadId: string; turnId: string; undoUpdateSeq: number },
    meta: UpdateMeta,
  ): Promise<{ consumed: boolean; seq?: number }>;

  /**
   * Read durable reversal records for a document, optionally scoped by thread and status.
   * Returned records should be suitable for redo-stack rehydration after live state is lost.
   */
  readReversals(
    docId: string,
    opts?: { threadId?: string; status?: ReversalRecord["status"][] },
  ): Promise<ReversalRecord[]>;
}
