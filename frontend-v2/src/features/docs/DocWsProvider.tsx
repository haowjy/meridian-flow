// ═══════════════════════════════════════════════════════════════════
// DocWsProvider — React context for the doc WS connection.
//
// Wraps WsClient for /ws/projects/{projectId}/docs. Routes notify
// events to TanStack Query invalidation. Exposes connection state
// via useDocWsConnection() hook.
//
// No stream subscriptions in v1 — this provider only handles the
// notify lane for cache coherence on doc/proposal changes.
// ═══════════════════════════════════════════════════════════════════

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { ConnectionState } from "@/lib/ws/protocol"
import { WsClient, buildWsUrl } from "@/lib/ws/ws-client"
import { handleNotify } from "@/lib/ws/notify-handler"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface DocWsContextValue {
  client: WsClient
}

const DocWsContext = createContext<DocWsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface DocWsProviderProps {
  projectId: string
  /** JWT provider — called on connect and each reconnect */
  getToken: () => Promise<string>
  children: ReactNode
}

/**
 * Manages a single WS connection to `/ws/projects/{projectId}/docs`.
 *
 * Mount once at the project layout level. All doc/proposal components
 * underneath get automatic cache invalidation via TanStack Query when
 * notify events arrive.
 */
export function DocWsProvider({
  projectId,
  getToken,
  children,
}: DocWsProviderProps) {
  const queryClient = useQueryClient()

  // Create the WsClient once per projectId. The initial getToken is
  // passed here; updateCallbacks below keeps it fresh without reconnecting.
  const client = useMemo(() => {
    const wsUrl = buildWsUrl(
      `/ws/projects/${encodeURIComponent(projectId)}/docs`,
    )
    return new WsClient({
      url: wsUrl,
      getToken,
    })
  }, [projectId, getToken])

  // Keep callbacks fresh — runs after render so the WsClient always
  // dispatches to the latest getToken and queryClient without a full
  // reconnect. Cheap property assignment, no WS side effects.
  useEffect(() => {
    client.updateCallbacks({
      getToken,
      onNotify: (msg) => {
        handleNotify(queryClient, msg)
      },
    })
  }, [client, getToken, queryClient])

  // Connect on mount, disconnect + destroy on unmount or projectId change
  useEffect(() => {
    client.connect()
    return () => {
      client.destroy()
    }
  }, [client])

  const contextValue = useMemo<DocWsContextValue>(
    () => ({ client }),
    [client],
  )

  return (
    <DocWsContext.Provider value={contextValue}>
      {children}
    </DocWsContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Read the doc WS connection state reactively.
 *
 * Uses `useSyncExternalStore` so components re-render only when
 * the connection state actually changes — no polling, no extra
 * subscriptions.
 *
 * Must be used inside a `<DocWsProvider>`.
 */
export function useDocWsConnection(): { state: ConnectionState } {
  const ctx = useContext(DocWsContext)
  if (!ctx) {
    throw new Error("useDocWsConnection must be used within a DocWsProvider")
  }

  const state = useSyncExternalStore(
    ctx.client.subscribe,
    ctx.client.getSnapshot,
  )

  return { state }
}
