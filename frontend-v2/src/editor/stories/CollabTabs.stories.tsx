/**
 * Collaboration + Tabs combined stories.
 *
 * Two side-by-side users, each with their own tab bar.
 * Per-chapter SimulatedServer, per-user Y.Docs.
 * Switching tabs independently -- remote cursors visible only
 * when both users have the same document open.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { Compartment } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"

import {
  createEditorExtensions,
  type EditorExtensionCompartments,
} from "../extensions"
import { createYUndoManager } from "../collab/undo-manager"
import { TabBar } from "../tabs/TabBar"
import type { TabInfo } from "../tabs/tab-manager"
import { SimulatedServer } from "./helpers/SimulatedServer"
import type { CollabUser } from "./helpers/CollabEditor"

const CHAPTERS = [
  {
    id: "ch-1",
    name: "Chapter 1: The Brass Door",
    content: `# Chapter 1: The Brass Door

Mara paused with her hand above the latch, listening to the building breathe.

The corridor smelled of rain and old varnish. She could hear the clock tower three streets over, its **deep** voice counting midnight.

> "You can keep a secret or keep your sleep. You rarely keep both."

The note had ended there.`,
  },
  {
    id: "ch-2",
    name: "Chapter 2: Winter Harbor",
    content: `# Chapter 2: Winter Harbor

By dusk, the bells were **late** and the docks were *restless*.

The ferryman said the river was listening. Nobody believed him until the water rose six inches in an hour, flooding the lower market stalls.

- Lantern oil
  - Spare wick
- Salted pears
- Maps (folded, in the coat)`,
  },
  {
    id: "ch-3",
    name: "Chapter 3: The Ferryman",
    content: `# Chapter 3: The Ferryman

He answered in *almost* a whisper.

They left behind ***half-finished promises*** and returned with none. The harbor district slept unevenly, and the ferries had stopped running after the second bell.

Read the [full report](https://example.com/report) before sunrise.`,
  },
]

const USERS: CollabUser[] = [
  { id: "alice", name: "Alice", color: "#3b82f6", colorLight: "#3b82f633" },
  { id: "bob", name: "Bob", color: "#ef4444", colorLight: "#ef444433" },
]

/**
 * A single user's tabbed editor pane with collab awareness.
 *
 * Each tab creates its own Y.Doc + Awareness and registers with
 * the per-chapter SimulatedServer.
 */
function CollabTabbedPane({
  servers,
  user,
}: {
  servers: Record<string, SimulatedServer>
  user: CollabUser
}) {
  const tabs: TabInfo[] = CHAPTERS.map((ch) => ({
    documentId: ch.id,
    documentName: ch.name,
    isModified: false,
  }))

  const [activeId, setActiveId] = useState(CHAPTERS[0].id)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewsRef = useRef<Map<string, EditorView>>(new Map())
  const containersRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const ydocsRef = useRef<Map<string, Y.Doc>>(new Map())
  const awarenessesRef = useRef<Map<string, Awareness>>(new Map())

  const ensureView = useCallback(
    (docId: string) => {
      if (!hostRef.current || viewsRef.current.has(docId)) return

      // Per-peer Y.Doc
      const ydoc = new Y.Doc()
      const ytext = ydoc.getText("content")
      const awareness = new Awareness(ydoc)

      awareness.setLocalStateField("user", {
        name: user.name,
        color: user.color,
        colorLight: user.colorLight,
      })

      ydocsRef.current.set(docId, ydoc)
      awarenessesRef.current.set(docId, awareness)

      // Register with per-chapter server
      const server = servers[docId]
      if (server) {
        server.addPeer(`${user.id}-${docId}`, ydoc, awareness)
      }

      const undoManager = createYUndoManager(ydoc)

      const compartments: EditorExtensionCompartments = {
        readOnly: new Compartment(),
        placeholder: new Compartment(),
        livePreview: new Compartment(),
        extra: new Compartment(),
      }

      const container = document.createElement("div")
      container.className = "editor-tab-container h-full min-h-0"
      container.style.display = "none"
      hostRef.current.appendChild(container)
      containersRef.current.set(docId, container)

      // Seed CM6 doc from Y.Text so server-synced content is visible.
      // addPeer applies Y.applyUpdate synchronously before this point,
      // but yCollab only observes incremental changes after its observer registers.
      const view = new EditorView({
        doc: ytext.toString(),
        extensions: createEditorExtensions({
          ytext,
          awareness,
          undoManager,
          compartments,
          livePreview: true,
          placeholder: "Start writing...",
        }),
        parent: container,
      })

      viewsRef.current.set(docId, view)
    },
    [servers, user],
  )

  const handleSwitch = useCallback(
    (docId: string) => {
      // Hide current
      const currentContainer = containersRef.current.get(activeId)
      if (currentContainer) {
        currentContainer.style.display = "none"
      }

      ensureView(docId)

      // Show target
      const targetContainer = containersRef.current.get(docId)
      if (targetContainer) {
        targetContainer.style.display = "block"
      }

      const view = viewsRef.current.get(docId)
      if (view) {
        view.requestMeasure()
        view.focus()
      }

      setActiveId(docId)
    },
    [activeId, ensureView],
  )

  // Initialize first tab on mount
  const setHost = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || hostRef.current === el) return
      hostRef.current = el
      ensureView(activeId)
      const container = containersRef.current.get(activeId)
      if (container) {
        container.style.display = "block"
      }
    },
    [activeId, ensureView],
  )

  // Cleanup: capture ref values in local variables so they're stable
  // when the cleanup function runs (React lint rule).
  useEffect(() => {
    const views = viewsRef.current
    const awarenesses = awarenessesRef.current
    const ydocs = ydocsRef.current
    return () => {
      for (const view of views.values()) {
        view.destroy()
      }
      for (const awareness of awarenesses.values()) {
        awareness.destroy()
      }
      for (const docId of ydocs.keys()) {
        servers[docId]?.removePeer(`${user.id}-${docId}`)
      }
      for (const ydoc of ydocs.values()) {
        ydoc.destroy()
      }
    }
  }, [servers, user.id])

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/80">
      {/* User badge */}
      <div className="flex items-center gap-2 border-b border-border/80 bg-muted/40 px-3 py-1.5">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: user.color }}
        />
        <span className="text-sm font-medium">{user.name}</span>
      </div>

      {/* Tab bar */}
      <TabBar
        tabs={tabs}
        activeTabId={activeId}
        onSwitch={handleSwitch}
        onClose={() => {}}
      />

      {/* Editor area */}
      <div ref={setHost} className="min-h-0 flex-1" />
    </div>
  )
}

function CollabWithTabsDemo() {
  const [servers] = useState(() =>
    Object.fromEntries(
      CHAPTERS.map((ch) => [ch.id, new SimulatedServer(ch.content)]),
    ) as Record<string, SimulatedServer>,
  )

  useEffect(() => {
    return () => {
      for (const server of Object.values(servers)) {
        server.destroy()
      }
    }
  }, [servers])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="rounded-xl border border-border/80 bg-[oklch(0.96_0.01_80)] p-3 shadow-sm dark:bg-[oklch(0.25_0.01_80)]">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
          <span className="text-xs font-medium text-foreground/80">
            Simulated Server (per-chapter)
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            Each chapter has its own server. Switch tabs independently.
          </span>
        </div>
      </div>
      <p className="text-sm text-muted-foreground px-1">
        Two users with independent tab bars. Remote cursors are visible when
        both users have the same chapter open. Switch tabs to see cursors
        appear and disappear.
      </p>
      <div className="grid grid-cols-2 gap-4 h-[600px]">
        {USERS.map((user) => (
          <CollabTabbedPane
            key={user.id}
            servers={servers}
            user={user}
          />
        ))}
      </div>
    </div>
  )
}

const meta = {
  title: "Editor/CollabTabs",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const CollabWithTabs: Story = {
  render: () => <CollabWithTabsDemo />,
}
