/**
 * IndexedDB persistence for Y.Doc using y-indexeddb.
 *
 * Health-tracked persistence layer: tracks whether IDB sync completed,
 * monitors for open/write failures, and emits status changes so the
 * UI can warn when local persistence is degraded or unavailable.
 *
 * Status transitions:
 *   healthy → degraded (sync timeout)
 *   healthy | degraded → unavailable (open failure / write error)
 *   degraded → healthy (late sync after timeout)
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocalPersistenceStatus = "healthy" | "degraded" | "unavailable"

export interface LocalPersistenceHealth {
  status: LocalPersistenceStatus
  timedOut: boolean
  lastError: Error | null
}

export interface IdbPersistenceHandle {
  provider: IndexeddbPersistence
  /** Resolves when initial sync completes or times out after 3s. */
  synced: Promise<{ timedOut: boolean }>
  /** Get current health snapshot. */
  getHealth(): LocalPersistenceHealth
  /**
   * Push-based health listener (useSyncExternalStore compatible).
   * Returns an unsubscribe function.
   */
  subscribeHealth(
    listener: (health: LocalPersistenceHealth) => void,
  ): () => void
  /** Delete the IDB database for this document. Safe if DB doesn't exist. */
  clearData(): Promise<void>
  /** Destroy the provider, clean up listeners, close IDB connection. */
  destroy(): Promise<void>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** IDB timeout in milliseconds. Prevents blocking editor init on corrupt IDB. */
const IDB_SYNC_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** IDB database name for a document. Matches the pattern used by y-indexeddb. */
function idbName(documentId: string): string {
  return `meridian-doc-${documentId}`
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create IndexedDB persistence for a Y.Doc with health tracking.
 *
 * The returned `synced` promise resolves with `{ timedOut: boolean }`
 * when IDB data is loaded or after 3 seconds. If it timed out, health
 * moves to 'degraded'. If IDB failed to open, health moves to
 * 'unavailable'. Late sync after a timeout recovers health to 'healthy'.
 *
 * The provider stays alive for continuous offline safety — edits are
 * persisted to IDB as they happen, not just on initial load.
 */
export function createIdbPersistence(
  documentId: string,
  ydoc: Y.Doc,
): IdbPersistenceHandle {
  const dbName = idbName(documentId)

  // --- Health state -----------------------------------------------------------

  let health: LocalPersistenceHealth = {
    status: "healthy",
    timedOut: false,
    lastError: null,
  }
  const listeners = new Set<(health: LocalPersistenceHealth) => void>()

  function setHealth(next: LocalPersistenceHealth) {
    if (
      health.status === next.status &&
      health.timedOut === next.timedOut &&
      health.lastError === next.lastError
    ) {
      return
    }
    health = next
    for (const listener of listeners) {
      listener(health)
    }
  }

  // --- Provider ---------------------------------------------------------------

  const provider = new IndexeddbPersistence(dbName, ydoc)

  // --- Sync race --------------------------------------------------------------

  let syncedNormally = false
  let syncTimedOut = false

  // Shared resolver — can be called from the timeout path, the _db rejection
  // path, or the normal sync path. Only the first call takes effect.
  let resolveSynced: (result: { timedOut: boolean }) => void
  let syncedResolved = false

  const synced = new Promise<{ timedOut: boolean }>((resolve) => {
    resolveSynced = (result: { timedOut: boolean }) => {
      if (syncedResolved) return
      syncedResolved = true
      resolve(result)
    }

    const timeout = setTimeout(() => {
      if (!syncedNormally) {
        syncTimedOut = true
        // Distinguish "IDB didn't open" from "IDB opened but sync is slow".
        // provider.db is set by y-indexeddb only after the IDB open succeeds.
        if (provider.db === null) {
          setHealth({
            status: "unavailable",
            timedOut: true,
            lastError: new Error("IndexedDB failed to open within timeout"),
          })
        } else {
          setHealth({
            status: "degraded",
            timedOut: true,
            lastError: null,
          })
        }
        resolveSynced({ timedOut: true })
      }
    }, IDB_SYNC_TIMEOUT_MS)

    provider.once("synced", () => {
      syncedNormally = true
      clearTimeout(timeout)
      // If we already timed out but then sync completed late, recover.
      // Keep timedOut=true so callers know the initial sync was slow.
      if (syncTimedOut) {
        setHealth({
          status: "healthy",
          timedOut: true,
          lastError: null,
        })
      }
      resolveSynced({ timedOut: syncTimedOut })
    })
  })

  // Detect IDB open failures by catching the internal _db promise.
  // y-indexeddb doesn't expose a public error event, so this is the
  // only reliable way to detect open failures (e.g. private browsing,
  // quota exceeded, corrupt DB). The _db property is an implementation
  // detail but is stable across y-indexeddb versions.
  const internalDbPromise = (
    provider as unknown as { _db: Promise<IDBDatabase> }
  )._db
  internalDbPromise.catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    setHealth({
      status: "unavailable",
      timedOut: health.timedOut,
      lastError: error,
    })
    // Resolve synced immediately — no point waiting for 3s timeout when
    // the DB will never open.
    resolveSynced({ timedOut: false })
  })

  // --- Public API -------------------------------------------------------------

  function getHealth(): LocalPersistenceHealth {
    return health
  }

  function subscribeHealth(
    listener: (health: LocalPersistenceHealth) => void,
  ): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Delete the IDB database for this document. Safe if DB doesn't exist.
   *
   * Must be called AFTER destroy() — calling while the provider is active
   * can corrupt the y-indexeddb handle.
   */
  async function clearData(): Promise<void> {
    // Use the raw IndexedDB API since y-indexeddb doesn't expose a public
    // clear method. Wrapped in a promise for clean async semantics.
    // Must not throw on a missing database — deleteDatabase on a
    // non-existent DB is a successful no-op per the IDB spec.
    return new Promise<void>((resolve, reject) => {
      try {
        const request = indexedDB.deleteDatabase(dbName)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        // onblocked fires if other tabs have the DB open. Resolve anyway —
        // the delete will complete when they close their connections.
        request.onblocked = () => resolve()
      } catch {
        // indexedDB not available (e.g. SSR, restricted test environments)
        resolve()
      }
    })
  }

  async function destroy(): Promise<void> {
    listeners.clear()
    await provider.destroy()
  }

  return {
    provider,
    synced,
    getHealth,
    subscribeHealth,
    clearData,
    destroy,
  }
}
