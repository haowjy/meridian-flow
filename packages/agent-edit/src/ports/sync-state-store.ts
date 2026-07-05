/** Durable per-thread sync baseline for agent-edit runtime sessions. */
export interface SyncState {
  stateVector: Uint8Array;
  /** Full Yjs state at last sync — used to restore the runtime after restart. */
  syncedSnapshot: Uint8Array;
  /** Full Yjs state at last commitResponse — used as concurrent detection baseline. */
  committedSnapshot: Uint8Array;
  /** Explicit proof that the model has seen or authored the full document content. */
  hasKnownFullContent: boolean;
}

/** Persists the last committed runtime baseline used to resume write sync after restart. */
export interface SyncStateStore {
  load(documentId: string, threadId: string): Promise<SyncState | null>;
  save(documentId: string, threadId: string, state: SyncState): Promise<void>;
  delete(documentId: string, threadId: string): Promise<void>;
}
