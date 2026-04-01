import { useCallback, useMemo, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { TabbedEditorShell } from "../TabbedEditorShell"
import {
  SessionPoolProvider,
  useDocumentSessions,
  useFollowActiveDoc,
  type DocHandle,
  type SessionPoolConfig,
  type UseDocumentSessionsResult,
} from "../session"

const DOCUMENTS: DocHandle[] = [
  { id: "ch-1", name: "Chapter 1: The Brass Door" },
  { id: "ch-2", name: "Chapter 2: Winter Harbor" },
  { id: "ch-3", name: "Chapter 3: The Ferryman" },
  { id: "ch-4", name: "Chapter 4: A Lantern in the Fog" },
]

const STORY_POOL_CONFIG: SessionPoolConfig = {
  idleMs: 120_000,
  warmBudget: 16,
  user: {
    userId: "storybook-user",
    userName: "Storybook Writer",
  },
}

function findDoc(docId: string): DocHandle | undefined {
  return DOCUMENTS.find((doc) => doc.id === docId)
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
      if (!name) return
      sessions.activate({ id: docId, name })
    },
    [sessions],
  )

  return (
    <div className="flex min-h-0 flex-col gap-2 rounded-xl border border-border/80 bg-background/70 p-3">
      <div className="rounded-md border border-border/80 bg-muted/20 p-2 text-xs text-muted-foreground">
        <div className="font-semibold text-foreground">{label}</div>
        <div>Active: {sessions.activeDocId ?? "none"}</div>
        <div>
          Open: {sessions.openDocs.length > 0
            ? sessions.openDocs.map((doc) => doc.id).join(", ")
            : "none"}
        </div>
      </div>
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

function MirroredSurfacesPlayground() {
  const studio = useDocumentSessions()
  const converse = useDocumentSessions()
  const [mirrored, setMirrored] = useState(true)
  const [selectedDocId, setSelectedDocId] = useState(DOCUMENTS[0].id)

  useFollowActiveDoc(
    mirrored ? studio.activeDocId : null,
    mirrored ? studio.openDocs : [],
    converse.activate,
  )

  const selectedDoc = useMemo(
    () => findDoc(selectedDocId) ?? DOCUMENTS[0],
    [selectedDocId],
  )

  const openOnStudio = useCallback(() => {
    studio.activate(selectedDoc)
  }, [selectedDoc, studio])

  const openOnConverse = useCallback(() => {
    converse.activate(selectedDoc)
  }, [converse, selectedDoc])

  return (
    <div className="flex h-[860px] flex-col gap-4 p-4">
      <div className="rounded-xl border border-border/80 bg-muted/30 p-3">
        <div className="mb-2 text-sm font-semibold">Mirroring Controls</div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={() => setMirrored((value) => !value)}
          >
            {mirrored ? "Switch To Independent" : "Switch To Mirrored"}
          </button>
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
            disabled={mirrored}
          >
            Open On Converse (Independent)
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Mode: {mirrored ? "Mirrored" : "Independent"}. In mirrored mode,
          Converse automatically follows Studio via useFollowActiveDoc.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
        <SurfacePane label="Studio (Driver)" sessions={studio} />
        <SurfacePane label="Converse (Follower)" sessions={converse} />
      </div>
    </div>
  )
}

function MirroredSurfacesDemo() {
  return (
    <SessionPoolProvider config={STORY_POOL_CONFIG}>
      <MirroredSurfacesPlayground />
    </SessionPoolProvider>
  )
}

const meta = {
  title: "Editor/MirroredSurfaces",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const MirroredVsIndependent: Story = {
  render: () => <MirroredSurfacesDemo />,
}
