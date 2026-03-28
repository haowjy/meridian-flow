/**
 * Collaboration playground.
 *
 * One configurable story: starts with 2 users, add/remove arbitrarily,
 * adjust latency, toggle disconnect/reconnect per user. All control
 * UI is inline playground chrome — not reusable components.
 */

import { useCallback, useEffect, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { SimulatedServer } from "./helpers/SimulatedServer"
import { CollabEditor, type CollabUser } from "./helpers/CollabEditor"
import { collabDocument } from "./helpers/mockContent"

// --- User palette ---

const USER_PALETTE: Omit<CollabUser, "id">[] = [
  { name: "Alice", color: "#3b82f6", colorLight: "#3b82f633" },
  { name: "Bob", color: "#ef4444", colorLight: "#ef444433" },
  { name: "Carol", color: "#10b981", colorLight: "#10b98133" },
  { name: "Dave", color: "#f59e0b", colorLight: "#f59e0b33" },
  { name: "Eve", color: "#8b5cf6", colorLight: "#8b5cf633" },
  { name: "Frank", color: "#ec4899", colorLight: "#ec489933" },
  { name: "Grace", color: "#06b6d4", colorLight: "#06b6d433" },
  { name: "Hank", color: "#84cc16", colorLight: "#84cc1633" },
]

const LATENCY_OPTIONS = [0, 50, 200, 500, 2000] as const

let nextUserId = 0
function createUser(index: number): CollabUser {
  const slot = USER_PALETTE[index % USER_PALETTE.length]
  const id = `user-${nextUserId++}`
  return { id, ...slot }
}

// --- Playground ---

function CollabPlayground() {
  const [server] = useState(() => new SimulatedServer(collabDocument))
  const [users, setUsers] = useState<CollabUser[]>(() => [
    createUser(0),
    createUser(1),
  ])
  const [latency, setLatency] = useState(0)
  const [connectionState, setConnectionState] = useState<Record<string, boolean>>({})

  useEffect(() => () => server.destroy(), [server])

  // Keep connection state in sync with user list.
  useEffect(() => {
    // setState inside effect is intentional: re-keying the map when the user list changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnectionState((prev) => {
      const next: Record<string, boolean> = {}
      for (const user of users) {
        next[user.id] = prev[user.id] ?? true
      }
      return next
    })
  }, [users])

  const handleLatencyChange = useCallback(
    (ms: number) => {
      setLatency(ms)
      server.setLatency(ms)
    },
    [server],
  )

  const toggleConnection = useCallback(
    (userId: string) => {
      setConnectionState((prev) => {
        const next = { ...prev, [userId]: !prev[userId] }
        if (next[userId]) {
          server.reconnect(userId)
        } else {
          server.disconnect(userId)
        }
        return next
      })
    },
    [server],
  )

  const addUser = useCallback(() => {
    setUsers((prev) => {
      if (prev.length >= USER_PALETTE.length) return prev
      return [...prev, createUser(prev.length)]
    })
  }, [])

  const removeUser = useCallback(
    (userId: string) => {
      setUsers((prev) => {
        if (prev.length <= 1) return prev
        return prev.filter((u) => u.id !== userId)
      })
      setConnectionState((prev) => {
        const next = { ...prev }
        delete next[userId]
        return next
      })
    },
    [],
  )

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Control bar */}
      <div className="rounded-xl border border-border/80 bg-[oklch(0.96_0.01_80)] p-3 shadow-sm dark:bg-[oklch(0.25_0.01_80)]">
        <div className="flex flex-wrap items-center gap-4">
          {/* Server status */}
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
            <span className="text-xs font-medium text-foreground/80">
              Simulated Server
            </span>
          </div>

          {/* Latency */}
          <div className="flex items-center gap-2">
            <label htmlFor="latency" className="text-xs text-muted-foreground">
              Latency:
            </label>
            <select
              id="latency"
              value={latency}
              onChange={(e) => handleLatencyChange(Number(e.target.value))}
              className="h-7 rounded-md border border-border/80 bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring/70"
            >
              {LATENCY_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms === 0 ? "0ms (instant)" : `${ms}ms`}
                </option>
              ))}
            </select>
          </div>

          {/* Add user */}
          <div className="ml-auto">
            {users.length < USER_PALETTE.length && (
              <button
                type="button"
                onClick={addUser}
                className="rounded-md border border-dashed border-border/80 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
              >
                + Add user
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Editor grid */}
      <div className="grid grid-cols-2 gap-4">
        {users.map((user) => (
          <div
            key={user.id}
            className="overflow-hidden rounded-lg border border-border/80"
          >
            {/* User badge with connection toggle and remove */}
            <div className="flex items-center gap-2 border-b border-border/80 bg-muted/40 px-3 py-1.5">
              <span
                className="h-2.5 w-2.5 rounded-full transition-colors"
                style={{
                  backgroundColor: connectionState[user.id]
                    ? user.color
                    : "oklch(0.6 0 0)",
                }}
              />
              <span className="text-sm font-medium">{user.name}</span>
              <button
                type="button"
                onClick={() => toggleConnection(user.id)}
                className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
                  connectionState[user.id]
                    ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    : "bg-success/10 text-success hover:bg-success/20"
                }`}
              >
                {connectionState[user.id] ? "Disconnect" : "Reconnect"}
              </button>
              {users.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeUser(user.id)}
                  className="text-xs text-muted-foreground transition hover:text-foreground"
                  title={`Remove ${user.name}`}
                >
                  ×
                </button>
              )}
            </div>
            <div className="h-[500px]">
              <CollabEditor server={server} user={user} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Meta + Export ---

const meta = {
  title: "Editor/Collaboration",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const Playground: Story = {
  render: () => <CollabPlayground />,
}
