/** Durable per-thread sync baseline for agent-edit runtime sessions. */
export interface SyncState {
  stateVector: Uint8Array;
  committedSnapshot: Uint8Array;
}

/** Persists the last committed runtime baseline used to resume write sync after restart. */
export interface SyncStateStore {
  load(documentId: string, threadId: string): Promise<SyncState | null>;
  save(documentId: string, threadId: string, state: SyncState): Promise<void>;
  delete(documentId: string, threadId: string): Promise<void>;
}
