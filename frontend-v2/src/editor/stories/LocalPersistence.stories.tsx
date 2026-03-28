/**
 * Local persistence health stories.
 *
 * Demonstrates the IDB persistence health tracking system:
 * - Live: real Y.Doc + IndexedDB persistence with live health subscription
 * - HealthStates: gallery of all three health states (healthy / degraded / unavailable)
 *
 * The health indicator is story-local UI, not a reusable component — the
 * persistence layer is headless by design. Real consumers will build
 * their own indicators via subscribeHealth() + useSyncExternalStore.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import * as Y from "yjs"
import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  createIdbPersistence,
  type IdbPersistenceHandle,
  type LocalPersistenceHealth,
  type LocalPersistenceStatus,
} from "../collab/idb-persistence"

// ---------------------------------------------------------------------------
// Health indicator (story-local, not a reusable component)
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  LocalPersistenceStatus,
  { label: string; color: string; bg: string; message: string }
> = {
  healthy: {
    label: "Healthy",
    color: "text-success",
    bg: "bg-success",
    message: "Changes are being saved locally.",
  },
  degraded: {
    label: "Degraded",
    color: "text-warning",
    bg: "bg-warning",
    message: "Local sync is slow — changes may not be saved locally.",
  },
  unavailable: {
    label: "Unavailable",
    color: "text-destructive",
    bg: "bg-destructive",
    message: "Changes are not being saved locally.",
  },
}

function HealthBadge({ health }: { health: LocalPersistenceHealth }) {
  const config = STATUS_CONFIG[health.status]

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/80 p-4">
      {/* Status row */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${config.bg} ${
            health.status === "healthy" ? "animate-pulse" : ""
          }`}
        />
        <span className={`text-sm font-semibold ${config.color}`}>
          {config.label}
        </span>
        {health.timedOut && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            timed out
          </span>
        )}
      </div>

      {/* Message */}
      <p className="text-sm text-muted-foreground">{config.message}</p>

      {/* Error detail */}
      {health.lastError && (
        <pre className="mt-1 rounded bg-destructive/10 p-2 text-xs text-destructive">
          {health.lastError.message}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hook: subscribe to IdbPersistenceHandle health
// ---------------------------------------------------------------------------

function useIdbHealth(handle: IdbPersistenceHandle | null): LocalPersistenceHealth {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!handle) return () => {}
      return handle.subscribeHealth(() => onStoreChange())
    },
    [handle],
  )

  const getSnapshot = useCallback(() => {
    if (!handle) {
      return { status: "healthy" as const, timedOut: false, lastError: null }
    }
    return handle.getHealth()
  }, [handle])

  return useSyncExternalStore(subscribe, getSnapshot)
}

// ---------------------------------------------------------------------------
// Story: Live persistence
// ---------------------------------------------------------------------------

function LivePersistenceDemo() {
  const docId = useRef(`story-${Date.now()}`).current
  const [syncResult, setSyncResult] = useState<{ timedOut: boolean } | null>(null)

  // Create Y.Doc + IDB persistence once
  const { ydoc, handle } = useMemo(() => {
    const doc = new Y.Doc()
    const h = createIdbPersistence(docId, doc)
    return { ydoc: doc, handle: h }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const health = useIdbHealth(handle)

  // Wait for sync
  useEffect(() => {
    handle.synced.then(setSyncResult)
  }, [handle])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void handle.destroy()
      ydoc.destroy()
    }
  }, [handle, ydoc])

  // Seed some content
  useEffect(() => {
    const ytext = ydoc.getText("content")
    if (ytext.length === 0) {
      ytext.insert(0, "Hello from IndexedDB persistence!")
    }
  }, [ydoc])

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold text-foreground">
        Live IDB Persistence
      </h2>
      <p className="text-sm text-muted-foreground">
        Real Y.Doc backed by IndexedDB. Health updates in real time via{" "}
        <code className="rounded bg-muted px-1 text-xs">subscribeHealth()</code>.
      </p>

      <HealthBadge health={health} />

      <div className="flex flex-col gap-1 rounded border border-border/60 bg-muted/30 p-3 text-xs">
        <div>
          <span className="text-muted-foreground">Document ID:</span>{" "}
          <code>{docId}</code>
        </div>
        <div>
          <span className="text-muted-foreground">Sync result:</span>{" "}
          {syncResult
            ? syncResult.timedOut
              ? "timed out"
              : "synced normally"
            : "pending..."}
        </div>
        <div>
          <span className="text-muted-foreground">IDB name:</span>{" "}
          <code>meridian-doc-{docId}</code>
        </div>
      </div>

      {/* clearData button */}
      <button
        type="button"
        onClick={() => void handle.clearData()}
        className="w-fit rounded-md border border-border/80 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
      >
        Clear IDB Data
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Story: Health states gallery
// ---------------------------------------------------------------------------

function HealthStatesGallery() {
  const states: { title: string; health: LocalPersistenceHealth }[] = [
    {
      title: "Healthy",
      health: { status: "healthy", timedOut: false, lastError: null },
    },
    {
      title: "Degraded (sync timeout)",
      health: { status: "degraded", timedOut: true, lastError: null },
    },
    {
      title: "Unavailable (IDB open failure)",
      health: {
        status: "unavailable",
        timedOut: true,
        lastError: new Error(
          "Failed to execute 'open' on 'IDBFactory': access denied",
        ),
      },
    },
    {
      title: "Healthy (recovered after timeout)",
      health: { status: "healthy", timedOut: true, lastError: null },
    },
  ]

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold text-foreground">
        Persistence Health States
      </h2>
      <p className="text-sm text-muted-foreground">
        All possible health states rendered side by side. In production, these
        drive the sync status indicator in the editor title bar.
      </p>

      <div className="grid grid-cols-2 gap-4">
        {states.map((s) => (
          <div key={s.title} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {s.title}
            </span>
            <HealthBadge health={s.health} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Meta + Exports
// ---------------------------------------------------------------------------

const meta = {
  title: "Editor/LocalPersistence",
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const Live: Story = {
  name: "Live IDB Persistence",
  render: () => <LivePersistenceDemo />,
}

export const HealthStates: Story = {
  name: "Health States Gallery",
  render: () => <HealthStatesGallery />,
}
