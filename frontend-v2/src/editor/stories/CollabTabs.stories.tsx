import { useCallback, useMemo, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { TabbedEditorShell } from "../components/TabbedEditorShell"
import {
  SessionPoolProvider,
  useDocumentSessions,
  type DocHandle,
  type SessionPoolConfig,
  type UseDocumentSessionsResult,
} from "../session"

const DOCUMENTS: DocHandle[] = [
  { id: "ch-1", name: "Chapter 1: The Brass Door" },
  { id: "ch-2", name: "Chapter 2: Winter Harbor" },
  { id: "ch-3", name: "Chapter 3: The Ferryman" },
  { id: "ch-4", name: "Chapter 4: A Lantern in the Fog" },
  { id: "ch-5", name: "Chapter 5: Tidewater" },
  { id: "ch-6", name: "Chapter 6: The Broken Compass" },
  { id: "ch-7", name: "Chapter 7: Harbor Glass" },
  { id: "ch-8", name: "Chapter 8: Third Bell" },
]

const STORY_POOL_CONFIG: SessionPoolConfig = {
  idleMs: 120_000,
  warmBudget: 24,
  user: {
    userId: "storybook-user",
    userName: "Storybook Writer",
  },
}

function findDoc(docId: string): DocHandle | undefined {
  return DOCUMENTS.find((doc) => doc.id === docId)
}

function SessionStatePanel({
  label,
  sessions,
}: {
  label: string
  sessions: UseDocumentSessionsResult
}) {
  const activeSession = sessions.activeSessionSnapshot

  return (
    <div className="rounded-lg border border-border/80 bg-muted/30 p-3 text-xs">
      <div className="font-semibold">{label}</div>
      <div className="mt-2 space-y-1 text-muted-foreground">
        <div>Active doc: {sessions.activeDocId ?? "none"}</div>
        <div>
          Open docs: {sessions.openDocs.length > 0
            ? sessions.openDocs.map((doc) => doc.id).join(", ")
            : "none"}
        </div>
        <div>Sync: {activeSession?.syncState ?? "n/a"}</div>
        <div>Connection: {activeSession?.connectionState ?? "n/a"}</div>
        <div>Frozen: {activeSession?.frozenReason ?? "none"}</div>
        <div>IDB: {activeSession?.idbHealth.status ?? "n/a"}</div>
      </div>
    </div>
  )
}

function SurfacePane({
  label,
  sessions,
}: {
  label: string
  sessions: UseDocumentSessionsResult
}) {
  const activeDoc = useMemo(
    () => sessions.openDocs.find((doc) => doc.id === sessions.activeDocId),
    [sessions.activeDocId, sessions.openDocs],
  )

  const handleActivateDoc = useCallback(
    (docId: string) => {
      const openDoc = sessions.openDocs.find((doc) => doc.id === docId)
      const knownDoc = findDoc(docId)
      const name = openDoc?.name ?? knownDoc?.name
      if (name === undefined) return
      sessions.activate({ id: docId, name })
    },
    [sessions],
  )

  return (
    <div className="flex min-h-0 flex-col gap-3 rounded-xl border border-border/80 bg-background/70 p-3">
      <SessionStatePanel label={label} sessions={sessions} />
      <div className="min-h-0 flex-1">
        <TabbedEditorShell
          openDocs={sessions.openDocs}
          activeDocId={sessions.activeDocId}
          onActivateDoc={handleActivateDoc}
          onCloseDoc={sessions.close}
          documentName={activeDoc?.name ?? "Untitled"}
          connectionState={sessions.activeSessionSnapshot?.connectionState ?? "disconnected"}
          getContent={() => sessions.getActiveView()?.state.doc.toString() ?? ""}
        >
          <div ref={sessions.hostRef} className="h-full min-h-0" />
        </TabbedEditorShell>
      </div>
    </div>
  )
}

function CollabTabsPlayground() {
  const studio = useDocumentSessions()
  const converse = useDocumentSessions()
  const [selectedDocId, setSelectedDocId] = useState(DOCUMENTS[0].id)

  const selectedDoc = useMemo(
    () => findDoc(selectedDocId) ?? DOCUMENTS[0],
    [selectedDocId],
  )

  const openOnStudio = useCallback(() => {
    studio.activate(selectedDoc)
  }, [studio, selectedDoc])

  const openOnConverse = useCallback(() => {
    converse.activate(selectedDoc)
  }, [converse, selectedDoc])

  const openOnBoth = useCallback(() => {
    studio.activate(selectedDoc)
    window.setTimeout(() => {
      converse.activate(selectedDoc)
    }, 80)
  }, [converse, selectedDoc, studio])

  const openEightOnStudio = useCallback(() => {
    DOCUMENTS.forEach((doc, index) => {
      window.setTimeout(() => {
        studio.activate(doc)
      }, index * 120)
    })
  }, [studio])

  return (
    <div className="flex h-[860px] flex-col gap-4 p-4">
      <div className="rounded-xl border border-border/80 bg-muted/30 p-3">
        <div className="mb-2 text-sm font-semibold">Session Controls</div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            className="rounded border border-border/80 bg-background px-2 py-1"
            value={selectedDocId}
            onChange={(event) => setSelectedDocId(event.target.value)}
          >
            {DOCUMENTS.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openOnStudio}
          >
            Open On Studio
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openOnConverse}
          >
            Open On Converse
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openOnBoth}
          >
            Open Same Doc On Both
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openEightOnStudio}
          >
            Open 8 Docs On Studio (LRU)
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
        <SurfacePane label="Studio" sessions={studio} />
        <SurfacePane label="Converse" sessions={converse} />
      </div>
    </div>
  )
}

function CollabTabsDemo() {
  return (
    <SessionPoolProvider config={STORY_POOL_CONFIG}>
      <CollabTabsPlayground />
    </SessionPoolProvider>
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
  render: () => <CollabTabsDemo />,
}
