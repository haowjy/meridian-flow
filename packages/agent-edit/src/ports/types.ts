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
  /** Serialized origin: `agent:<turnId>` | `human:<userId>` | `system` | `system:reconcile`. */
  origin: string;
  /** Groups updates into undo units when present. */
  actorTurnId?: string;
  /** Successful model response that authored this update. */
  authoringResponseId?: string;
  /** Prepared scope used for save and rollback selection, never a provider FK. */
  editScopeId?: string;
  /** Monotonic sequence within the document. */
  seq: number;
}

/** One persisted update row with its journal sequence and payload. */
export interface PersistedUpdate {
  seq: number;
  update: Uint8Array;
  meta: UpdateMeta;
}

/** Checkpoint plus ordered updates returned by journal read. */
export interface JournalSnapshot {
  /** Host authority captured with this snapshot, when the journal has generations. */
  authority?: { authorityId: string; generation: bigint };
  /** Latest checkpoint bytes (full encoded Y.Doc state), or null if none. */
  checkpoint: Uint8Array | null;
  /** Updates in ascending sequence order, filtered by read opts when provided. */
  updates: PersistedUpdate[];
  /**
   * Durable source log head represented by this snapshot, including its checkpoint.
   */
  persistenceWatermark?: number;
}

/** Outcome of folding old updates into a checkpoint. */
export interface CompactionResult {
  /** Number of update rows folded into the new checkpoint. */
  updatesFolded: number;
}
