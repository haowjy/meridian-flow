/**
 * Shared journal and persistence types for UpdateJournal adapters.
 */

/** Structured edit origin — serializes to UpdateMeta.origin (`agent:…`, `human:…`, `system`). */
export type UpdateOrigin =
  | { kind: "agent"; turnId: string }
  | { kind: "human"; userId: string }
  | { kind: "system" };

/** Metadata stored alongside each appended Yjs update. */
export interface UpdateMeta {
  /** Serialized origin: `agent:<turnId>` | `human:<userId>` | `system`. */
  origin: string;
  /** Groups updates into undo units when present. */
  actorTurnId?: string;
  /** Successful model response that authored an agent mutation or reversal. */
  authoringResponseId?: string;
  /** Commit-sealed proof that this response destroyed unseen writer content. */
  destructiveSweep?: DestructiveSweepEvidence;
  /** Reversal actor attribution; origin remains system so undo/redo classification is unchanged. */
  reversalActor?: ReversalActor;
  /** Monotonic sequence within the document. */
  seq: number;
}

export type DestructiveSweepEvidence = {
  version: 1;
  blocks: Array<{
    clientID: number;
    clock: number;
    hash: string;
    body: string;
  }>;
};

/** One persisted update row with its journal sequence and payload. */
export interface PersistedUpdate {
  seq: number;
  update: Uint8Array;
  meta: UpdateMeta;
}

/** Checkpoint plus ordered updates returned by journal read. */
export interface JournalSnapshot {
  /** Latest checkpoint bytes (full encoded Y.Doc state), or null if none. */
  checkpoint: Uint8Array | null;
  /** Updates in ascending sequence order, filtered by read opts when provided. */
  updates: PersistedUpdate[];
}

/** Outcome of folding old updates into a checkpoint and expiring reversals. */
export interface CompactionResult {
  /** Number of update rows folded into the new checkpoint. */
  updatesFolded: number;
  /** Number of reversal records marked expired. */
  reversalsExpired: number;
}

export type ReversalStatus = "active" | "reversed" | "redone" | "reconciled" | "expired";

export type ReversalActor =
  | { type: "agent"; responseId?: string }
  | { type: "user"; userId: string };

/**
 * Durable metadata linking an agent turn to its persisted undo update.
 * Written atomically with the undo update via ReversalStore.persistUndo and
 * consumed atomically with the redo update via ReversalStore.persistRedo.
 */
export interface ReversalRecord {
  documentId: string;
  /** Original turn is retained as context; reversal identity is the write handle. */
  turnId: string | null;
  threadId: string;
  /** Successful model response that authored an agent reversal, when applicable. */
  authoringResponseId?: string;
  /** Stable model-facing write handles reversed by the same undo update. */
  writeIds: string[];
  status: ReversalStatus;
  /** Journal sequence of the persisted undo update (for durable redo). */
  undoUpdateSeq: number;
  /** Journal sequence of the redo update currently re-applying this row, when redone. */
  redoUpdateSeq?: number;
  expiresAt?: Date;
  reversedAt?: Date;
  reversedByUserId?: string;
  /**
   * Ephemeral journal high-watermark captured when the undo plan was built. Used
   * only inside `persistUndo` to reject rows that land after planning; never
   * written to durable reversal storage.
   */
  persistGuardWatermark?: number;
}
