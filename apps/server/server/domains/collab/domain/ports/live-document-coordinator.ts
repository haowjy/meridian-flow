/** The live host's own document door, for collab code that works on a live room in place. */
import type * as Y from "yjs";

/**
 * A live document's room, serialized per document in this process. Agent-edit never sees this:
 * it reads and saves through its `DocumentCoordinator`. The mutex excludes other callers of
 * this door, never a writer's WebSocket frames (LOCK-WS, `websocket-concurrency.md`).
 */
export interface LiveDocumentCoordinator {
  /**
   * Runs `fn` on the open room, caught up from the journal first, under the document's mutex.
   * Rejects with DocumentNotFoundError when the document is missing.
   */
  withDocument<T>(
    docId: string,
    fn: (doc: Y.Doc) => Promise<T>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  /** Applies committed journal rows the room lacks. Idempotent. */
  recover(docId: string): Promise<void>;
}
