import type * as Y from "yjs";

/**
 * Exclusive access to live Y.Docs — one mutator at a time per document.
 * Server adapters use KeyedMutex + Hocuspocus; desktop uses a process-level lock.
 */
export interface DocumentCoordinator {
  /**
   * Acquire exclusive access to a document's live Y.Doc for the duration of fn.
   * Serializes concurrent callers for the same docId; different documents run concurrently.
   * Rejects when the document cannot be loaded or the coordinator is shutting down.
   */
  withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;

  /**
   * Replay persisted-but-not-applied updates on startup or recovery.
   * Idempotent: safe to call multiple times; applies only updates missing from the live doc.
   */
  recover(docId: string): Promise<void>;
}
