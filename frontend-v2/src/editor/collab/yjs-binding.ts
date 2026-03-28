/**
 * Yjs <-> CM6 binding via y-codemirror.next.
 *
 * Hard constraint: one Y.Doc per chapter/document. This limits tombstone
 * growth and isolates chapters from each other. See design doc section 5.
 *
 * WebSocket transport is a stub following the CollabSyncRuntime pattern
 * from v1. The real transport is wired via DocumentSessionManager in the
 * data integration phase.
 *
 * Origin guards distinguish local vs remote changes:
 * - Local human actions use ORIGIN_HUMAN (tracked by Y.UndoManager)
 * - Remote sync uses null origin (excluded from undo)
 * - collabActiveRef suppresses onChange saves when collab is active
 */

import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

import {
  createIdbPersistence,
  type IdbPersistenceHandle,
} from "./idb-persistence"
import type { AwarenessUserInfo } from "./remote-cursors"
import { getCursorColor } from "./remote-cursors"
import { createYUndoManager } from "./undo-manager"

/**
 * Resources created per-document collab session.
 *
 * Lifecycle: created on tab open / collab connect, destroyed on tab
 * evict / close / collab disconnect. The TabManager auto-destroys
 * the session on eviction and close.
 */
export interface CollabSession {
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  idbPersistence: IdbPersistenceHandle
  /** Destroy all resources. Safe to call multiple times. */
  destroy: () => void
}

export interface CollabSessionOptions {
  documentId: string
  userId: string
  userName: string
}

/**
 * Create a collab session for a document.
 *
 * Sets up Y.Doc, Y.Text, Awareness, Y.UndoManager, and IndexedDB
 * persistence. The CM6 binding (yCollab) is handled by
 * createEditorExtensions() — this function only creates document-scoped
 * Yjs resources.
 *
 * The caller should:
 * 1. `await session.idbPersistence.synced` before activating
 * 2. Pass session.ytext, session.awareness, session.undoManager to
 *    createEditorExtensions()
 * 3. Call `session.destroy()` on disconnect
 */
export function createCollabSession(
  options: CollabSessionOptions,
): CollabSession {
  const { documentId, userId, userName } = options

  // Per-chapter Y.Doc (hard constraint -- never share across chapters)
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText("content")
  const awareness = new Awareness(ydoc)

  // Set local user info for remote cursor display.
  // y-codemirror.next reads awareness.getLocalState().user to render
  // colored cursors with name labels.
  const cursorColor = getCursorColor(userId)
  const userInfo: AwarenessUserInfo = {
    name: userName,
    color: cursorColor.color,
    colorLight: cursorColor.light,
  }
  awareness.setLocalStateField("user", userInfo)

  // Y.UndoManager scoped to text + proposal status metadata.
  // Passed to yCollab so the undo plugin captures cursor positions
  // for restoration on undo/redo.
  const undoManager = createYUndoManager(ydoc)

  // IndexedDB persistence for offline safety.
  // Stays alive for continuous persistence -- not just initial load.
  const idbPersistence = createIdbPersistence(documentId, ydoc)

  let destroyed = false

  function destroy() {
    if (destroyed) return
    destroyed = true
    undoManager.destroy()
    awareness.destroy()
    idbPersistence.destroy()
    ydoc.destroy()
  }

  return {
    ydoc,
    ytext,
    awareness,
    undoManager,
    idbPersistence,
    destroy,
  }
}

// ---------------------------------------------------------------------------
// WebSocket transport stub
// ---------------------------------------------------------------------------

/**
 * WebSocket transport interface following the CollabSyncRuntime pattern.
 *
 * In production, the real DocumentSessionManager provides this.
 * The transport is decoupled from the binding -- it's a send/receive layer.
 */
export interface CollabTransport {
  /** Apply a binary Yjs update received from the server. */
  receiveUpdate: (update: Uint8Array) => void
  /** Disconnect: remove the update listener from the Y.Doc. */
  disconnect: () => void
}

/**
 * Connect a Y.Doc to a transport (WebSocket stub).
 *
 * Sets up the update listener with origin guard to prevent echo loops:
 * updates received from the transport are applied with a sentinel origin,
 * and the listener skips updates with that origin.
 *
 * @param ydoc - The Y.Doc to connect
 * @param sendBinary - Callback to send binary updates to the server
 * @returns Transport handle with receiveUpdate and disconnect
 */
export function connectTransport(
  ydoc: Y.Doc,
  sendBinary: (data: Uint8Array) => void,
): CollabTransport {
  // Sentinel origin to distinguish transport-applied updates from local edits.
  // Using a Symbol ensures no accidental collision with other origins.
  const transportOrigin = Symbol("transport")

  function onUpdate(update: Uint8Array, origin: unknown) {
    // Don't re-broadcast updates we received from the server
    if (origin === transportOrigin) return
    sendBinary(update)
  }

  ydoc.on("update", onUpdate)

  return {
    receiveUpdate(update: Uint8Array) {
      Y.applyUpdate(ydoc, update, transportOrigin)
    },
    disconnect() {
      ydoc.off("update", onUpdate)
    },
  }
}
