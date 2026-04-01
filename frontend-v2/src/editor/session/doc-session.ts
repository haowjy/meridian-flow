/**
 * DocSession — canonical document-scoped lifecycle owner.
 *
 * Owns Y.Doc, Y.Text, Awareness, UndoManager, IDB persistence,
 * health state, invalidation state, and transport placeholders.
 * Does NOT own an EditorView — that belongs to ViewController (Phase 3).
 *
 * Lifecycle:
 *   1. new DocSession(config)           — creates Yjs resources, starts IDB
 *   2. await session.initialize()       — waits for IDB sync, connects WS
 *   3. ... editing happens via Y.Doc ...
 *   4. await session.destroy()          — tears down everything
 *
 * Key invariants:
 *   - Y.Doc is the source of truth, never CM6 EditorState
 *   - At most one live EditorView per session (attachedViewCount: 0 | 1)
 *   - Generation counter is managed by SessionPool, not DocSession
 *   - Frozen sessions reject further local edits
 */

import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

import {
  createIdbPersistence,
  type IdbPersistenceHandle,
  type LocalPersistenceHealth,
} from "../collab/idb-persistence"
import { getCursorColor, type AwarenessUserInfo } from "../collab/remote-cursors"
import { createYUndoManager } from "../collab/undo-manager"

import type {
  ConnectionState,
  DocSyncState,
  DocumentWsProvider,
  DocumentWsProviderFactory,
  FrozenReason,
} from "./types"

// Re-export types that consumers of DocSession commonly need
export type { LocalPersistenceHealth } from "../collab/idb-persistence"
export type {
  ConnectionState,
  DocSyncState,
  DocumentWsProvider,
  DocumentWsProviderFactory,
  FrozenReason,
} from "./types"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DocSessionConfig {
  documentId: string
  userId: string
  userName: string
  wsProviderFactory?: DocumentWsProviderFactory
  getAccessToken?: () => Promise<string>
}

// ---------------------------------------------------------------------------
// DocSession
// ---------------------------------------------------------------------------

export class DocSession {
  readonly id: string
  readonly ydoc: Y.Doc
  readonly ytext: Y.Text
  readonly awareness: Awareness
  readonly undoManager: Y.UndoManager
  readonly idbPersistence: IdbPersistenceHandle

  // -- View lifecycle --------------------------------------------------------

  /** Hard constraint: at most one live EditorView per DocSession. */
  attachedViewCount: 0 | 1 = 0

  /**
   * Monotonic lease generation — incremented by SessionPool operations
   * (ensureSession, preload, lease transfer, invalidation).
   * Used as a stale-timer guard: idle timers capture the current generation
   * and only fire if it hasn't changed.
   */
  generation: number = 0

  /** LRU timestamp set when the last view detaches. Used by SessionPool for warm-session eviction. */
  lastDetachedAt: number | null = null

  // -- Document state --------------------------------------------------------

  /** Non-null when session is frozen (document deleted or access revoked). */
  frozenReason: FrozenReason | null = null

  /**
   * True when local edits exist that haven't been sent to the server.
   * Set by Y.Doc update listener when disconnected, cleared when WS
   * connects and updates are flushed (Phase 4).
   */
  hasPendingLocalChanges: boolean = false

  /** Coarse sync state for UI indicators. */
  syncState: DocSyncState = "disconnected"

  /** WebSocket connection state machine state. */
  connectionState: ConnectionState = "disconnected"

  // -- WS provider -----------------------------------------------------------

  /** WebSocket provider — null until Phase 4 makes it real. */
  wsProvider: DocumentWsProvider | null = null

  // -- Private ---------------------------------------------------------------

  private destroyed = false
  private readonly listeners = new Set<() => void>()
  private idbHealthUnsubscribe: (() => void) | null = null
  private readonly wsProviderFactory?: DocumentWsProviderFactory
  private readonly getAccessToken?: () => Promise<string>

  constructor(config: DocSessionConfig) {
    this.id = config.documentId
    this.wsProviderFactory = config.wsProviderFactory
    this.getAccessToken = config.getAccessToken

    // Per-chapter Y.Doc — hard constraint: never share across chapters.
    this.ydoc = new Y.Doc()
    this.ytext = this.ydoc.getText("content")
    this.awareness = new Awareness(this.ydoc)

    // Set local user info for remote cursor display.
    // y-codemirror.next reads awareness.getLocalState().user to render
    // colored cursors with name labels.
    const cursorColor = getCursorColor(config.userId)
    const userInfo: AwarenessUserInfo = {
      name: config.userName,
      color: cursorColor.color,
      colorLight: cursorColor.light,
    }
    this.awareness.setLocalStateField("user", userInfo)

    // Y.UndoManager scoped to text + proposal status metadata.
    // Reuses the origin policy from collab/undo-manager.ts:
    // tracks ORIGIN_HUMAN, ORIGIN_ACCEPT, ORIGIN_REJECT, ORIGIN_THREAD.
    // null origin (remote sync) is explicitly excluded.
    this.undoManager = createYUndoManager(this.ydoc)

    // IDB persistence — starts loading immediately. The constructor does
    // not await sync; that happens in initialize().
    this.idbPersistence = createIdbPersistence(config.documentId, this.ydoc)

    // Track local changes while disconnected for hasPendingLocalChanges.
    this.ydoc.on("update", this.handleYDocUpdate)

    // Bridge IDB health changes to session-level listeners so consumers
    // using subscribe() are notified when persistence degrades.
    this.idbHealthUnsubscribe = this.idbPersistence.subscribeHealth(() => {
      this.notify()
    })
  }

  // -- Public API ------------------------------------------------------------

  /**
   * Initialize: await IDB initial sync, connect WS if factory was provided.
   *
   * Call this after constructing the session. The IDB persistence starts
   * loading in the constructor, so initialize() just awaits completion.
   *
   * @returns Whether the IDB sync timed out (3s timeout from idb-persistence).
   */
  async initialize(): Promise<{ timedOut: boolean }> {
    const result = await this.idbPersistence.synced

    // Connect WS if a factory was provided and we haven't been destroyed
    // while waiting for IDB sync.
    if (this.wsProviderFactory && !this.destroyed) {
      if (!this.getAccessToken) {
        throw new Error("DocSession requires getAccessToken when wsProviderFactory is set")
      }
      this.wsProvider = this.wsProviderFactory({
        documentId: this.id,
        ydoc: this.ydoc,
        awareness: this.awareness,
        getAccessToken: this.getAccessToken,
      })
      this.wsProvider.connect()
    }

    return result
  }

  /** Get current IDB health snapshot. */
  getIdbHealth(): LocalPersistenceHealth {
    return this.idbPersistence.getHealth()
  }

  /**
   * Subscribe to IDB health changes. Returns unsubscribe function.
   *
   * Delegates to the underlying IdbPersistenceHandle — health listeners
   * receive the full LocalPersistenceHealth object on every status change.
   */
  subscribeIdbHealth(
    listener: (health: LocalPersistenceHealth) => void,
  ): () => void {
    return this.idbPersistence.subscribeHealth(listener)
  }

  /**
   * Subscribe to session state changes. Returns unsubscribe function.
   *
   * Listeners are called (with no arguments) when any observable property
   * changes: syncState, connectionState, frozenReason, hasPendingLocalChanges,
   * or IDB health status.
   *
   * Compatible with React's useSyncExternalStore subscribe contract.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Freeze the session — prevents further local edits.
   *
   * Used when the server reports document deletion (404) or access
   * revocation (403). The UI should show recovery options.
   * Freezing is one-way: a frozen session cannot be unfrozen.
   */
  freeze(reason: FrozenReason): void {
    if (this.frozenReason !== null) return // already frozen
    this.frozenReason = reason
    this.notify()
  }

  /** Check if session is frozen. */
  get isFrozen(): boolean {
    return this.frozenReason !== null
  }

  /**
   * Destroy all resources. Safe to call multiple times.
   *
   * Teardown order matters: undo manager and awareness reference the Y.Doc,
   * so destroy them before the doc. IDB persistence is async because it
   * closes the IndexedDB connection.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true

    // Remove Y.Doc update listener first to prevent stale notifications
    this.ydoc.off("update", this.handleYDocUpdate)

    // Unsubscribe from IDB health bridge
    if (this.idbHealthUnsubscribe) {
      this.idbHealthUnsubscribe()
      this.idbHealthUnsubscribe = null
    }

    // Destroy WS provider if present
    if (this.wsProvider) {
      this.wsProvider.destroy()
      this.wsProvider = null
    }

    // Destroy in dependency order:
    // 1. UndoManager (references Y.Doc types)
    // 2. Awareness (references Y.Doc)
    // 3. IDB persistence (async — closes IndexedDB connection)
    // 4. Y.Doc (the root resource)
    this.undoManager.destroy()
    this.awareness.destroy()
    await this.idbPersistence.destroy()
    this.ydoc.destroy()

    // Clear all listeners — no more notifications after destroy
    this.listeners.clear()
  }

  // -- Private ---------------------------------------------------------------

  /** Notify all general subscribers of a state change. */
  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /**
   * Y.Doc update handler — tracks hasPendingLocalChanges.
   *
   * null origin = remote sync (from WebSocket provider or y-indexeddb).
   * Any other origin = local edit (human typing, accept, reject, etc).
   *
   * When a local edit happens while not connected, we mark pending changes
   * and update syncState so the UI can show "changes saved locally".
   *
   * Arrow function to preserve `this` binding for ydoc.on/off.
   */
  private handleYDocUpdate = (_update: Uint8Array, origin: unknown): void => {
    // null origin means remote sync — not a local change
    if (origin === null) return

    // Only track pending changes when not connected to server
    if (this.connectionState !== "connected" && !this.hasPendingLocalChanges) {
      this.hasPendingLocalChanges = true
      this.syncState = "local-changes-pending"
      this.notify()
    }
  }
}
