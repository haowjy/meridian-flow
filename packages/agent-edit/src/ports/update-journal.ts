import type { CompactionResult, JournalSnapshot, ReversalRecord, UpdateMeta } from "./types.js";

/**
 * Ordered Yjs update journal — the foundation every deployment implements.
 * Adapters guarantee durable append order, checkpoint storage, and atomic reversal writes.
 */
export interface UpdateJournal {
  /**
   * Append a Yjs update with metadata (origin, turn, sequence).
   * Returns the assigned monotonic sequence number for this document.
   * Rejects when seq in meta does not match the next expected sequence.
   */
  append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number>;

  /**
   * Read checkpoint plus updates in sequence order.
   * When since/until are set, only updates with seq in [since, until] are included.
   * Returns an empty updates array when the document has no journal entries.
   */
  read(docId: string, opts?: { since?: number; until?: number }): Promise<JournalSnapshot>;

  /**
   * Write a checkpoint (full Y.Doc encoded state).
   * Replaces the previous checkpoint for this document; does not delete retained updates.
   */
  checkpoint(docId: string, state: Uint8Array): Promise<void>;

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
}
