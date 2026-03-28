import { useCallback, useRef, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { Compartment } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { TabbedEditorShell } from "./TabbedEditorShell"
import {
  createEditorExtensions,
  createLocalEditorSession,
  type EditorExtensionCompartments,
  type LocalEditorSession,
} from "./extensions"
import type { TabInfo } from "./tabs/tab-manager"

const chapterContent: Record<string, string> = {
  "ch-1": `# Chapter 1: The Brass Door

Mara paused with her hand above the latch, listening to the building breathe.

The corridor smelled of rain and old varnish. She could hear the clock tower three streets over, its **deep** voice counting midnight.

> "You can keep a secret or keep your sleep. You rarely keep both."

The note had ended there.`,
  "ch-2": `# Chapter 2: Winter Harbor

By dusk, the bells were **late** and the docks were *restless*.

The ferryman said the river was listening. Nobody believed him until the water rose six inches in an hour, flooding the lower market stalls.

- Lantern oil
  - Spare wick
- Salted pears
- Maps (folded, in the coat)`,
  "ch-3": `# Chapter 3: The Ferryman

He answered in *almost* a whisper.

They left behind ***half-finished promises*** and returned with none. The harbor district slept unevenly, and the ferries had stopped running after the second bell.

Read the [full report](https://example.com/report) before sunrise.`,
  "ch-4": `# Chapter 4: A Lantern in the Fog

The fog came in thick, wrapping the harbor like cotton.

\`\`\`ts
export function strikeBell(hour: number): string {
  return \`Bell \${hour}\`
}
\`\`\`

She lit the lantern and held it high. The light barely reached three paces.`,
  "ch-5": `# Chapter 5: Tidewater

The tide pulled the piers into shadow.

---

By morning, every boat in the harbor had shifted its mooring. The harbormaster blamed the current; the fishermen blamed the moon.`,
}

const initialTabs: TabInfo[] = [
  { documentId: "ch-1", documentName: "Chapter 1: The Brass Door", isModified: false },
  { documentId: "ch-2", documentName: "Chapter 2: Winter Harbor", isModified: true },
  { documentId: "ch-3", documentName: "Chapter 3: The Ferryman", isModified: false },
  { documentId: "ch-4", documentName: "Chapter 4: A Lantern in the Fog", isModified: false },
  { documentId: "ch-5", documentName: "Chapter 5: Tidewater", isModified: true },
]

function TabbedEditorDemo() {
  const [tabs, setTabs] = useState(initialTabs)
  const [activeId, setActiveId] = useState("ch-1")
  const viewsRef = useRef<Map<string, EditorView>>(new Map())
  const sessionsRef = useRef<Map<string, LocalEditorSession>>(new Map())
  const hostRef = useRef<HTMLDivElement>(null)

  // Track which containers exist per document
  const containersRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const ensureView = useCallback((docId: string) => {
    if (!hostRef.current) return

    // Create container and view if not existing
    if (!viewsRef.current.has(docId)) {
      // Create local Yjs session and seed with chapter content
      const session = createLocalEditorSession()
      const content = chapterContent[docId] ?? ""
      if (content) {
        session.ytext.insert(0, content)
      }
      sessionsRef.current.set(docId, session)

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

      // Seed CM6 doc from Y.Text so pre-inserted content is visible.
      // yCollab only observes incremental changes after its observer registers.
      const view = new EditorView({
        doc: session.ytext.toString(),
        extensions: createEditorExtensions({
          ytext: session.ytext,
          awareness: session.awareness,
          undoManager: session.undoManager,
          compartments,
          livePreview: true,
          placeholder: "Start writing...",
        }),
        parent: container,
      })
      viewsRef.current.set(docId, view)
    }
  }, [])

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

  const handleClose = useCallback(
    (docId: string) => {
      // Destroy view and container
      const view = viewsRef.current.get(docId)
      if (view) {
        view.destroy()
        viewsRef.current.delete(docId)
      }
      const session = sessionsRef.current.get(docId)
      if (session) {
        session.destroy()
        sessionsRef.current.delete(docId)
      }
      const container = containersRef.current.get(docId)
      if (container) {
        container.remove()
        containersRef.current.delete(docId)
      }

      setTabs((prev) => prev.filter((t) => t.documentId !== docId))
      if (activeId === docId) {
        const remaining = tabs.filter((t) => t.documentId !== docId)
        if (remaining.length > 0) {
          handleSwitch(remaining[0].documentId)
        } else {
          setActiveId("")
        }
      }
    },
    [activeId, tabs, handleSwitch],
  )

  // Create initial view on mount
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

  const activeTab = tabs.find((t) => t.documentId === activeId)

  return (
    <div className="mx-auto h-[700px] w-full max-w-5xl">
      <TabbedEditorShell
        tabs={tabs}
        activeTabId={activeId}
        onSwitchTab={handleSwitch}
        onCloseTab={handleClose}
        documentName={activeTab?.documentName ?? "Untitled"}
        onRename={(newName) => {
          setTabs((prev) =>
            prev.map((t) =>
              t.documentId === activeId ? { ...t, documentName: newName } : t,
            ),
          )
        }}
        connectionState="connected"
        wordCount={1847}
        lastSaved="Saved 2m ago"
        getContent={() => {
          const view = viewsRef.current.get(activeId)
          return view?.state.doc.toString() ?? ""
        }}
      >
        <div ref={setHost} className="h-full min-h-0" />
      </TabbedEditorShell>
    </div>
  )
}

const noop = () => {}

const meta = {
  title: "Editor/TabbedEditor",
  component: TabbedEditorShell,
  tags: ["autodocs"],
  args: {
    tabs: [],
    activeTabId: null,
    onSwitchTab: noop,
    onCloseTab: noop,
    documentName: "Untitled",
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof TabbedEditorShell>

export default meta
type Story = StoryObj<typeof meta>

export const FullDemo: Story = {
  render: () => <TabbedEditorDemo />,
}
