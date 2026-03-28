/**
 * SessionPool stories.
 *
 * Demonstrates the warm-session manager lifecycle:
 * - Creating sessions (warm open)
 * - Releasing sessions (idle timer starts)
 * - Preloading sessions
 * - Idle timeout eviction
 * - Warm budget eviction
 * - Session invalidation (freeze)
 *
 * The dashboard is story-local UI, not a reusable component — SessionPool
 * is headless by design. Real consumers use subscribe() + useSyncExternalStore.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { SessionPool } from "../session/session-pool"
import type { DocSession } from "../session/doc-session"

// ---------------------------------------------------------------------------
// Types for display
// ---------------------------------------------------------------------------

interface SessionInfo {
  id: string
  generation: number
  attachedViewCount: 0 | 1
  lastDetachedAt: number | null
  frozenReason: string | null
  isFrozen: boolean
  hasPendingLocalChanges: boolean
  syncState: string
}

function sessionToInfo(session: DocSession): SessionInfo {
  return {
    id: session.id,
    generation: session.generation,
    attachedViewCount: session.attachedViewCount,
    lastDetachedAt: session.lastDetachedAt,
    frozenReason: session.frozenReason,
    isFrozen: session.isFrozen,
    hasPendingLocalChanges: session.hasPendingLocalChanges,
    syncState: session.syncState,
  }
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function statusLabel(info: SessionInfo): {
  label: string
  color: string
  bg: string
} {
  if (info.isFrozen) {
    return {
      label: `Frozen (${info.frozenReason})`,
      color: "text-destructive",
      bg: "bg-destructive",
    }
  }
  if (info.attachedViewCount > 0) {
    return { label: "Attached", color: "text-success", bg: "bg-success" }
  }
  return { label: "Detached (warm)", color: "text-warning", bg: "bg-warning" }
}

function formatDetachedAgo(lastDetachedAt: number | null, now: number): string {
  if (lastDetachedAt === null) return "never"
  return `${((now - lastDetachedAt) / 1000).toFixed(1)}s ago`
}

function SessionCard({ info, now }: { info: SessionInfo; now: number }) {
  const status = statusLabel(info)
  const detachedAgo = formatDetachedAgo(info.lastDetachedAt, now)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/80 p-3">
      <div className="flex items-center justify-between">
        <code className="text-sm font-semibold text-foreground">{info.id}</code>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${status.bg}`} />
          <span className={`text-xs font-medium ${status.color}`}>
            {status.label}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>
          Gen: <span className="text-foreground">{info.generation}</span>
        </div>
        <div>
          Views: <span className="text-foreground">{info.attachedViewCount}</span>
        </div>
        <div>
          Detached: <span className="text-foreground">{detachedAgo}</span>
        </div>
        <div>
          Sync: <span className="text-foreground">{info.syncState}</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hook: subscribe to SessionPool
// ---------------------------------------------------------------------------

function usePoolSessions(pool: SessionPool | null): SessionInfo[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!pool) return () => {}
      return pool.subscribe(onStoreChange)
    },
    [pool],
  )

  // Cache snapshot to return a referentially stable value.
  // useSyncExternalStore in React 19 strict mode calls getSnapshot
  // twice and compares by reference — new arrays cause infinite loops.
  const EMPTY: SessionInfo[] = useMemo(() => [], [])
  const cachedRef = useRef<SessionInfo[]>(EMPTY)

  const getSnapshot = useCallback(() => {
    if (!pool) return EMPTY
    const next = pool.getSessionIds().map((id) => {
      const session = pool.getSession(id)!
      return sessionToInfo(session)
    })

    const prev = cachedRef.current
    // Shallow compare: same length, same fields for each entry
    if (
      prev.length === next.length &&
      prev.every(
        (p, i) =>
          p.id === next[i].id &&
          p.generation === next[i].generation &&
          p.attachedViewCount === next[i].attachedViewCount &&
          p.lastDetachedAt === next[i].lastDetachedAt &&
          p.frozenReason === next[i].frozenReason &&
          p.hasPendingLocalChanges === next[i].hasPendingLocalChanges &&
          p.syncState === next[i].syncState,
      )
    ) {
      return prev
    }
    cachedRef.current = next
    return next
  }, [pool, EMPTY])

  return useSyncExternalStore(subscribe, getSnapshot)
}

// ---------------------------------------------------------------------------
// Demo component
// ---------------------------------------------------------------------------

function SessionPoolDemo({
  idleMs = 10_000,
  warmBudget = 3,
}: {
  idleMs?: number
  warmBudget?: number
}) {
  const nextDocId = useRef(1)
  const [log, setLog] = useState<string[]>([])

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50))
  }, [])

  const pool = useMemo(() => {
    const p = new SessionPool({
      idleMs,
      warmBudget,
      user: { userId: "story-user", userName: "Story User" },
    })
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh display periodically to update "detached X ago" timers.
  // Storing Date.now() in state so it's available during render without
  // calling an impure function inline.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void pool.destroy()
    }
  }, [pool])

  const sessions = usePoolSessions(pool)

  const handleCreate = useCallback(async () => {
    const id = `chapter-${nextDocId.current++}`
    const session = await pool.ensureSession(id)
    session.attachedViewCount = 1
    addLog(`Created + attached: ${id}`)
  }, [pool, addLog])

  const handlePreload = useCallback(async () => {
    const id = `chapter-${nextDocId.current++}`
    await pool.preload(id)
    addLog(`Preloaded (warm, detached): ${id}`)
  }, [pool, addLog])

  const handleRelease = useCallback(
    (id: string) => {
      pool.releaseSession(id)
      addLog(`Released: ${id} (idle timer started, ${idleMs / 1000}s)`)
    },
    [pool, addLog, idleMs],
  )

  const handleAttach = useCallback(
    async (id: string) => {
      const session = await pool.ensureSession(id)
      session.attachedViewCount = 1
      addLog(`Re-attached: ${id} (gen ${session.generation})`)
    },
    [pool, addLog],
  )

  const handleInvalidate = useCallback(
    async (id: string) => {
      await pool.invalidateSession(id, "document-deleted")
      addLog(`Invalidated: ${id} (frozen: document-deleted)`)
    },
    [pool, addLog],
  )

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          SessionPool Dashboard
        </h2>
        <p className="text-sm text-muted-foreground">
          Budget: {warmBudget} warm sessions | Idle timeout: {idleMs / 1000}s
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          className="rounded-md border border-border/80 px-3 py-1.5 text-xs transition hover:border-foreground/40 hover:text-foreground"
        >
          + Open Document
        </button>
        <button
          type="button"
          onClick={() => void handlePreload()}
          className="rounded-md border border-border/80 px-3 py-1.5 text-xs transition hover:border-foreground/40 hover:text-foreground"
        >
          + Preload Document
        </button>
      </div>

      {/* Sessions grid */}
      {sessions.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          No sessions. Click "Open Document" or "Preload Document" to start.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((info) => (
            <div key={info.id} className="flex flex-col gap-2">
              <SessionCard info={info} now={now} />
              <div className="flex gap-1">
                {info.attachedViewCount > 0 && !info.isFrozen && (
                  <button
                    type="button"
                    onClick={() => handleRelease(info.id)}
                    className="rounded border border-border/60 px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
                  >
                    Release
                  </button>
                )}
                {info.attachedViewCount === 0 && !info.isFrozen && (
                  <button
                    type="button"
                    onClick={() => void handleAttach(info.id)}
                    className="rounded border border-border/60 px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
                  >
                    Re-attach
                  </button>
                )}
                {!info.isFrozen && (
                  <button
                    type="button"
                    onClick={() => void handleInvalidate(info.id)}
                    className="rounded border border-destructive/40 px-2 py-1 text-[10px] text-destructive/70 transition hover:text-destructive"
                  >
                    Invalidate
                  </button>
                )}
              </div>
            </div>
          ))}
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
              <div key={i} className="text-xs text-muted-foreground font-mono">
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
  title: "Editor/SessionPool",
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const Dashboard: Story = {
  name: "Pool Dashboard",
  render: () => <SessionPoolDemo />,
}

export const SmallBudget: Story = {
  name: "Small Budget (2 sessions)",
  render: () => <SessionPoolDemo warmBudget={2} idleMs={5000} />,
}

export const FastEviction: Story = {
  name: "Fast Idle Eviction (3s)",
  render: () => <SessionPoolDemo idleMs={3000} />,
}
