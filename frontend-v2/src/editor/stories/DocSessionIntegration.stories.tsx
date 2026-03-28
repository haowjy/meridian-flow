/**
 * DocSession → Editor integration story.
 *
 * Proves the full Phase 2 stack works end-to-end:
 *   create DocSession → mount Editor → type → content lands in Y.Text → IDB persists.
 *
 * Skips ViewController (Phase 3) — wires DocSession resources directly into
 * the Editor component to validate the Yjs plumbing in isolation.
 *
 * Key scenarios exercised:
 *   - Create session + mount editor
 *   - Live Y.Text length tracking
 *   - Destroy & recreate (content rehydrates from IDB)
 *   - Clear IDB + recreate (starts empty)
 *   - Freeze session (simulates document deletion)
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { DocSession } from "../session/doc-session"
import type { LocalPersistenceHealth } from "../collab/idb-persistence"
import { Editor } from "../Editor"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionLifecycleState = "idle" | "created" | "initialized" | "destroyed"

interface SessionSnapshot {
  lifecycleState: SessionLifecycleState
  idbHealth: LocalPersistenceHealth
  ytextLength: number
  hasPendingLocalChanges: boolean
  frozenReason: string | null
}

const INITIAL_SNAPSHOT: SessionSnapshot = {
  lifecycleState: "idle",
  idbHealth: { status: "healthy", timedOut: false, lastError: null },
  ytextLength: 0,
  hasPendingLocalChanges: false,
  frozenReason: null,
}

// ---------------------------------------------------------------------------
// Hook: subscribe to DocSession state
// ---------------------------------------------------------------------------

/**
 * Subscribes to a DocSession's observable state via useSyncExternalStore.
 *
 * Tracks both the session's own state (frozen, pending changes) and
 * the Y.Text length via ytext.observe. Folds ytext observation into the
 * same subscription callback so React sees a single external store.
 */
function useSessionSnapshot(
  session: DocSession | null,
  lifecycleState: SessionLifecycleState,
): SessionSnapshot {
  // Unified subscribe: hooks both DocSession.subscribe and ytext.observe
  // into a single onStoreChange callback for useSyncExternalStore.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!session) return () => {}
      const unsubSession = session.subscribe(onStoreChange)
      // ytext.observe fires on every Y.Text mutation — bridge it to the
      // same store-change callback so getSnapshot picks up new length.
      const ytextObserver = () => onStoreChange()
      session.ytext.observe(ytextObserver)
      return () => {
        unsubSession()
        session.ytext.unobserve(ytextObserver)
      }
    },
    [session],
  )

  // Cache the snapshot to return a referentially stable value when
  // nothing has changed. useSyncExternalStore in React 19 strict mode
  // calls getSnapshot twice and compares by reference — returning a
  // new object every time causes an infinite re-render loop.
  const cachedRef = useRef<SessionSnapshot>(INITIAL_SNAPSHOT)

  const getSnapshot = useCallback((): SessionSnapshot => {
    const next: SessionSnapshot = !session
      ? { ...INITIAL_SNAPSHOT, lifecycleState }
      : {
          lifecycleState,
          idbHealth: session.getIdbHealth(),
          ytextLength: session.ytext.length,
          hasPendingLocalChanges: session.hasPendingLocalChanges,
          frozenReason: session.frozenReason,
        }

    const prev = cachedRef.current
    if (
      prev.lifecycleState === next.lifecycleState &&
      prev.idbHealth.status === next.idbHealth.status &&
      prev.idbHealth.timedOut === next.idbHealth.timedOut &&
      prev.ytextLength === next.ytextLength &&
      prev.hasPendingLocalChanges === next.hasPendingLocalChanges &&
      prev.frozenReason === next.frozenReason
    ) {
      return prev
    }
    cachedRef.current = next
    return next
  }, [session, lifecycleState])

  return useSyncExternalStore(subscribe, getSnapshot)
}

// ---------------------------------------------------------------------------
// Status indicator helpers
// ---------------------------------------------------------------------------

function idbStatusColor(status: LocalPersistenceHealth["status"]): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500"
    case "degraded":
      return "bg-amber-500"
    case "unavailable":
      return "bg-red-500"
  }
}

function lifecycleColor(state: SessionLifecycleState): string {
  switch (state) {
    case "idle":
      return "text-muted-foreground"
    case "created":
      return "text-amber-500"
    case "initialized":
      return "text-emerald-500"
    case "destroyed":
      return "text-red-500"
  }
}

// ---------------------------------------------------------------------------
// Indicator panel
// ---------------------------------------------------------------------------

function IndicatorPanel({ snapshot }: { snapshot: SessionSnapshot }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border/80 bg-muted/30 p-3 text-sm sm:grid-cols-3">
      {/* Session state */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Session:</span>
        <span className={`font-medium ${lifecycleColor(snapshot.lifecycleState)}`}>
          {snapshot.lifecycleState}
        </span>
      </div>

      {/* IDB health */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">IDB:</span>
        <span
          className={`inline-block h-2 w-2 rounded-full ${idbStatusColor(snapshot.idbHealth.status)}`}
        />
        <span className="font-medium text-foreground">
          {snapshot.idbHealth.status}
        </span>
      </div>

      {/* Y.Text length */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Y.Text length:</span>
        <span className="font-mono font-medium text-foreground">
          {snapshot.ytextLength}
        </span>
      </div>

      {/* Pending changes */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Pending changes:</span>
        <span
          className={`font-medium ${snapshot.hasPendingLocalChanges ? "text-amber-500" : "text-foreground"}`}
        >
          {snapshot.hasPendingLocalChanges ? "yes" : "no"}
        </span>
      </div>

      {/* Frozen reason */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Frozen:</span>
        <span
          className={`font-medium ${snapshot.frozenReason ? "text-red-500" : "text-foreground"}`}
        >
          {snapshot.frozenReason ?? "no"}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DocSessionPlayground
// ---------------------------------------------------------------------------

function DocSessionPlayground({ documentId = "test-doc-1" }: { documentId?: string }) {
  const [session, setSession] = useState<DocSession | null>(null)
  const [lifecycleState, setLifecycleState] = useState<SessionLifecycleState>("idle")
  const [log, setLog] = useState<string[]>([])

  // Track the session ref for cleanup — avoids stale closures in async ops
  const sessionRef = useRef<DocSession | null>(null)

  const addLog = useCallback((msg: string) => {
    setLog((prev) =>
      [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50),
    )
  }, [])

  const snapshot = useSessionSnapshot(session, lifecycleState)

  // -- Lifecycle actions ------------------------------------------------------

  const createSession = useCallback(async () => {
    // Destroy existing session first if any
    if (sessionRef.current) {
      await sessionRef.current.destroy()
      addLog("Destroyed previous session")
    }

    const newSession = new DocSession({
      documentId,
      userId: "story-user",
      userName: "Story User",
    })
    sessionRef.current = newSession
    setSession(newSession)
    setLifecycleState("created")
    addLog(`Created session for "${documentId}"`)

    // Initialize: await IDB sync
    const { timedOut } = await newSession.initialize()
    // Guard: session may have been replaced/destroyed during await
    if (sessionRef.current !== newSession) return
    setLifecycleState("initialized")
    addLog(
      timedOut
        ? "Initialized (IDB sync timed out)"
        : `Initialized (IDB synced, Y.Text length: ${newSession.ytext.length})`,
    )
  }, [documentId, addLog])

  const destroyAndRecreate = useCallback(async () => {
    if (sessionRef.current) {
      await sessionRef.current.destroy()
      setSession(null)
      setLifecycleState("destroyed")
      sessionRef.current = null
      addLog("Destroyed session — recreating...")
    }
    // Small delay so the "destroyed" state is visible in the UI
    await new Promise((resolve) => setTimeout(resolve, 200))
    await createSession()
    addLog("Recreated — content should rehydrate from IDB")
  }, [createSession, addLog])

  const clearIdbAndRecreate = useCallback(async () => {
    if (sessionRef.current) {
      // Must destroy before clearing IDB — calling clearData while provider
      // is active can corrupt the y-indexeddb handle.
      const oldSession = sessionRef.current
      sessionRef.current = null
      setSession(null)
      setLifecycleState("destroyed")
      await oldSession.destroy()
      await oldSession.idbPersistence.clearData()
      addLog("Destroyed session + cleared IDB data")
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    await createSession()
    addLog("Recreated after IDB clear — should start empty")
  }, [createSession, addLog])

  const freezeSession = useCallback(() => {
    if (!sessionRef.current) return
    sessionRef.current.freeze("document-deleted")
    addLog("Froze session (reason: document-deleted)")
  }, [addLog])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        void sessionRef.current.destroy()
      }
    }
  }, [])

  // -- Render -----------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          DocSession Integration
        </h2>
        <p className="text-sm text-muted-foreground">
          DocSession → Editor direct wiring. Document:{" "}
          <code className="text-foreground">{documentId}</code>
        </p>
      </div>

      {/* Indicators */}
      <IndicatorPanel snapshot={snapshot} />

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {!session && (
          <button
            type="button"
            onClick={() => void createSession()}
            className="rounded-md border border-border/80 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-500/20 dark:text-emerald-400"
          >
            Create Session
          </button>
        )}
        {session && (
          <>
            <button
              type="button"
              onClick={() => void destroyAndRecreate()}
              className="rounded-md border border-border/80 px-3 py-1.5 text-xs transition hover:border-foreground/40 hover:text-foreground"
            >
              Destroy &amp; Recreate
            </button>
            <button
              type="button"
              onClick={() => void clearIdbAndRecreate()}
              className="rounded-md border border-border/80 px-3 py-1.5 text-xs transition hover:border-foreground/40 hover:text-foreground"
            >
              Clear IDB
            </button>
            <button
              type="button"
              onClick={freezeSession}
              disabled={snapshot.frozenReason !== null}
              className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive/70 transition hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
            >
              Freeze
            </button>
          </>
        )}
      </div>

      {/* Editor area */}
      {session && lifecycleState === "initialized" ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Editor (bound to Y.Text)
          </span>
          <div className="h-64 overflow-auto rounded-lg border border-border/80">
            <Editor
              ytext={session.ytext}
              awareness={session.awareness}
              undoManager={session.undoManager}
              placeholder="Type here — content flows through Y.Text → IDB..."
              className="h-full"
            />
          </div>
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border/60">
          <p className="text-sm italic text-muted-foreground">
            {lifecycleState === "idle"
              ? 'Click "Create Session" to mount the editor'
              : "Initializing session..."}
          </p>
        </div>
      )}

      {/* Event log */}
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Event Log
        </h3>
        <div className="max-h-40 overflow-y-auto rounded border border-border/60 bg-muted/20 p-2">
          {log.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">No events yet.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="font-mono text-xs text-muted-foreground">
                {entry}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Meta + Exports
// ---------------------------------------------------------------------------

const meta = {
  title: "Editor/DocSession Integration",
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const Playground: Story = {
  name: "DocSession Playground",
  render: () => <DocSessionPlayground />,
}

export const CustomDocId: Story = {
  name: "Custom Document ID",
  render: () => <DocSessionPlayground documentId="chapter-42" />,
}
