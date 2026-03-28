/**
 * IndexedDB persistence for Y.Doc using y-indexeddb.
 *
 * Each per-chapter Y.Doc uses IndexedDB for offline safety:
 * - Edits survive browser crashes and network outages
 * - Fast document open: IndexedDB loads cached state before WebSocket connects
 * - Offline editing: user can continue writing without connection
 *
 * Tied to tab lifecycle: created on tab open, destroyed on tab close/evict.
 * Uses a 3-second timeout to prevent blocking on corrupt IDB.
 */

import { IndexeddbPersistence } from "y-indexeddb"
import type * as Y from "yjs"

export interface IdbPersistenceHandle {
  provider: IndexeddbPersistence
  /** Promise that resolves when initial sync completes (or times out after 3s). */
  synced: Promise<void>
  /** Destroy the provider and close the IDB connection. */
  destroy: () => void
}

/** IDB timeout in milliseconds. Prevents blocking editor init on corrupt IDB. */
const IDB_SYNC_TIMEOUT_MS = 3000

/**
 * Create IndexedDB persistence for a Y.Doc.
 *
 * The returned `synced` promise resolves when IDB data is loaded,
 * or after 3 seconds (whichever comes first). This prevents blocking
 * editor initialization on corrupt or slow IndexedDB.
 *
 * The provider stays alive for continuous offline safety -- edits are
 * persisted to IDB as they happen, not just on initial load.
 */
export function createIdbPersistence(
  documentId: string,
  ydoc: Y.Doc,
): IdbPersistenceHandle {
  const provider = new IndexeddbPersistence(`meridian-doc-${documentId}`, ydoc)

  const synced = Promise.race([
    new Promise<void>((resolve) => {
      provider.once("synced", () => resolve())
    }),
    new Promise<void>((resolve) => setTimeout(resolve, IDB_SYNC_TIMEOUT_MS)),
  ])

  return {
    provider,
    synced,
    destroy() {
      // IndexeddbPersistence.destroy() returns a Promise but we fire-and-forget
      // because tab close/evict shouldn't block on IDB cleanup.
      void provider.destroy()
    },
  }
}
