/**
 * Yjs <-> CM6 binding via y-codemirror.next.
 *
 * Hard constraint: one Y.Doc per chapter/document. This limits tombstone
 * growth and isolates chapters from each other. See design doc section 5.
 *
 * Document WebSocket transport is provided by document-ws-provider.ts.
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
 * NOTE: DocSession (in session/doc-session.ts) is the canonical lifecycle
 * owner going forward. It provides health tracking, sync state, freeze/
 * invalidation, and generation guards that this convenience function does
 * not. New code should use DocSession via SessionPool. This function is
 * retained for simple use cases (stories, tests) that don't need the full
 * session lifecycle.
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
