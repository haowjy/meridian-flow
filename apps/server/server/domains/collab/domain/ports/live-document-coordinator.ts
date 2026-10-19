/** The live host's own document door, for collab code that works on a live room in place. */
import type * as Y from "yjs";

/**
 * A live document's room, serialized per document in this process. Agent-edit never sees this:
 * it reads and saves through its `DocumentCoordinator`. The mutex excludes other callers of
 * this door, never a writer's WebSocket frames (LOCK-WS, `websocket-concurrency.md`).
 */
export interface LiveDocumentCoordinator {
  /**
   * Runs `fn` under the document's mutex. Outside a transaction `fn` gets the open room,
   * caught up from the committed journal first. Inside one it gets a private copy (the room,
   * the committed journal and the transaction's own rows) and the room is never touched: what
   * the transaction journals reaches the room through `deliver` after the root commits, and a
   * rollback leaves the room as it was (LOCK-WS). Rejects with DocumentNotFoundError when the
   * document is missing.
   */
  /** readOnly uses a disposable live-room-plus-journal cut, without room opening or delivery. */
  withDocument<T>(
    docId: string,
    fn: (doc: Y.Doc) => Promise<T>,
    options?: { timeoutMs?: number; signal?: AbortSignal; readOnly?: boolean },
  ): Promise<T>;
  /**
   * The committed journal's obligation to the open room, owned here: coalesced per document,
   * and after a failure retried with backoff for as long as Hocuspocus holds the room that fell
   * behind; it ends when a pass catches that room up or the room is unloaded (a load reads the
   * journal). Never closes or drops a room. Resolves once the first attempt settled; never
   * rejects.
   */
  deliver(docId: string): Promise<void>;
}
