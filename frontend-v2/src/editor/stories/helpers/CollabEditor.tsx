/**
 * Collab-aware editor for Storybook demos.
 *
 * Creates a local Yjs session per instance (no IDB, no WebSocket — just
 * in-memory Y.Doc + Awareness) and registers with a SimulatedServer for
 * sync. Remote cursors and real-time typing come from the y-codemirror.next
 * binding backed by the simulated relay.
 *
 * Each CollabEditor instance represents one "user" in the collab demo.
 */

import { useEffect, useMemo } from "react"

import { Editor } from "../../Editor"
import { createLocalEditorSession } from "../../extensions"
import type { SimulatedServer } from "./SimulatedServer"

export interface CollabUser {
  id: string
  name: string
  color: string
  colorLight: string
}

export interface CollabEditorProps {
  server: SimulatedServer
  user: CollabUser
  /** Unique peer ID for the server. Defaults to user.id */
  peerId?: string
}

/**
 * A single collaborative editor pane.
 *
 * Creates its own Y.Doc + Awareness (matching the real per-client isolation)
 * and registers with the SimulatedServer for sync.
 */
export function CollabEditor({ server, user, peerId }: CollabEditorProps) {
  const effectivePeerId = peerId ?? user.id

  // Local Yjs session with explicit awareness colors for the demo.
  // Uses createLocalEditorSession (no IDB persistence) — the
  // SimulatedServer handles all sync between peers.
  const session = useMemo(() => {
    const s = createLocalEditorSession()
    // Storybook users provide explicit colors for easy visual distinction.
    s.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      colorLight: user.colorLight,
    })
    return s
    // effectivePeerId change means a new peer identity — recreate session.
    // Color/name changes also require a fresh awareness state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePeerId, user.color, user.colorLight, user.name])

  useEffect(() => {
    // Register with the server (syncs initial state from server doc)
    server.addPeer(effectivePeerId, session.ydoc, session.awareness)

    return () => {
      server.removePeer(effectivePeerId)
      session.destroy()
    }
  }, [session, effectivePeerId, server])

  return (
    <Editor
      ytext={session.ytext}
      awareness={session.awareness}
      undoManager={session.undoManager}
      livePreview
      placeholder="Start writing..."
      className="h-full min-h-[200px]"
    />
  )
}
