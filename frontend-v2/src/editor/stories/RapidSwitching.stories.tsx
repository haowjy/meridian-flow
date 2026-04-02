import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { TabbedEditorShell } from "../components/TabbedEditorShell"
import {
  SessionPoolProvider,
  useDocumentSessions,
  type DocHandle,
  type SessionPoolConfig,
} from "../session"

const DOCUMENTS: DocHandle[] = [
  { id: "doc-a", name: "Document A" },
  { id: "doc-b", name: "Document B" },
  { id: "doc-c", name: "Document C" },
]

const STORY_POOL_CONFIG: SessionPoolConfig = {
  idleMs: 120_000,
  warmBudget: 12,
  user: {
    userId: "storybook-user",
    userName: "Storybook Writer",
  },
}

function findDoc(docId: string): DocHandle | undefined {
  return DOCUMENTS.find((doc) => doc.id === docId)
}

function RapidSwitchingPlayground() {
  const sessions = useDocumentSessions()
  const [result, setResult] = useState<string>("")
  const [history, setHistory] = useState<string[]>([])
  const latestActiveRef = useRef<string | null>(null)

  useEffect(() => {
    latestActiveRef.current = sessions.activeDocId
    if (sessions.activeDocId) {
      setHistory((prev) => [...prev, sessions.activeDocId!].slice(-12))
    }
  }, [sessions.activeDocId])

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

  const runRapidSwitch = useCallback(() => {
    setResult("Running A->B->C...")
    sessions.activate(DOCUMENTS[0])
    window.setTimeout(() => {
      sessions.activate(DOCUMENTS[1])
    }, 10)
    window.setTimeout(() => {
      sessions.activate(DOCUMENTS[2])
    }, 20)
    window.setTimeout(() => {
      const finalDocId = latestActiveRef.current
      if (finalDocId === "doc-c") {
        setResult("Final active doc is doc-c (expected)")
      } else {
        setResult(`Unexpected final doc: ${finalDocId ?? "none"}`)
      }
    }, 600)
  }, [sessions])

  const openA = useCallback(() => {
    sessions.activate(DOCUMENTS[0])
  }, [sessions])

  const openB = useCallback(() => {
    sessions.activate(DOCUMENTS[1])
  }, [sessions])

  const openC = useCallback(() => {
    sessions.activate(DOCUMENTS[2])
  }, [sessions])

  return (
    <div className="flex h-[820px] flex-col gap-4 p-4">
      <div className="rounded-xl border border-border/80 bg-muted/30 p-3">
        <div className="mb-2 text-sm font-semibold">Epoch Serialization Demo</div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={runRapidSwitch}
          >
            {"Rapid Activate A->B->C"}
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openA}
          >
            Open A
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openB}
          >
            Open B
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={openC}
          >
            Open C
          </button>
          <button
            type="button"
            className="rounded border border-border/80 px-2 py-1"
            onClick={() => {
              setHistory([])
              setResult("")
            }}
          >
            Clear Status
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Active: {sessions.activeDocId ?? "none"} | {result || "Idle"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Transition history: {history.length > 0 ? history.join(" -> ") : "none"}
        </p>
      </div>

      <div className="min-h-0 flex-1 rounded-xl border border-border/80 bg-background/70 p-3">
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

function RapidSwitchingDemo() {
  return (
    <SessionPoolProvider config={STORY_POOL_CONFIG}>
      <RapidSwitchingPlayground />
    </SessionPoolProvider>
  )
}

const meta = {
  title: "Editor/RapidSwitching",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const EpochSerialization: Story = {
  render: () => <RapidSwitchingDemo />,
}
