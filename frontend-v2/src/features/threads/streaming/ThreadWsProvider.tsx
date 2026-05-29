// ═══════════════════════════════════════════════════════════════════
// ThreadWsProvider — React context for the thread WS connection.
//
// Wraps WsClient for /ws/projects/{projectId}/threads. Routes notify
// events to TanStack Query invalidation. Creates and manages a
// StreamingChannelClient for stream subscribe/unsubscribe. Handles
// reconnect by re-subscribing all active streams.
//
// Pattern follows DocWsProvider (Phase 8) — same lifecycle, same
// reconnection strategy, extended with streaming channel management.
// ═══════════════════════════════════════════════════════════════════

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { Envelope } from "@/lib/ws/protocol"
import {
  CONTROL_RESPONSE_OP,
  NOTIFY_EVENT,
  RESOURCE_TYPE,
} from "@/lib/ws/protocol"
import { queryKeys } from "@/lib/queries/keys"
import { WsClient, buildWsUrl } from "@/lib/ws/ws-client"
import { handleNotify } from "@/lib/ws/notify-handler"

import { StreamingChannelClient } from "./streaming-channel-client"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ThreadWsContextValue {
  client: WsClient
  streaming: StreamingChannelClient
}

const ThreadWsContext = createContext<ThreadWsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface ThreadWsProviderProps {
  projectId: string
  /** JWT provider — called on connect and each reconnect */
  getToken: () => Promise<string>
  children: ReactNode
}

/**
 * Manages a single WS connection to `/ws/projects/{projectId}/threads`.
 *
 * Mount once at the project layout level. Provides:
 * - Automatic TanStack Query invalidation on notify events
 * - StreamingChannelClient for subscribing to turn streams
 * - Reconnect with re-subscribe of all active stream subscriptions
 *
 * Spawn discovery: when a `spawn_started` notify arrives, the provider
 * invalidates the spawn list query. Auto-subscribing to the spawn's
 * stream is left to the consuming component (it needs to know which
 * thread is actively viewed).
 */
export function ThreadWsProvider({
  projectId,
  getToken,
  children,
}: ThreadWsProviderProps) {
  const queryClient = useQueryClient()

  // Track whether we've already been connected at least once,
  // so we can distinguish initial connect from reconnect.
  const hasConnectedRef = useRef(false)

  // Create the WsClient + StreamingChannelClient once per projectId.
  const { client, streaming } = useMemo(() => {
    const wsUrl = buildWsUrl(
      `/ws/projects/${encodeURIComponent(projectId)}/threads`,
    )
    const wsClient = new WsClient({
      url: wsUrl,
      getToken,
    })
    const streamingClient = new StreamingChannelClient(wsClient)
    return { client: wsClient, streaming: streamingClient }
  }, [projectId, getToken])

  // Keep callbacks fresh — runs after render so WsClient always
  // dispatches to the latest handlers without reconnecting.
  useEffect(() => {
    client.updateCallbacks({
      getToken,

      onNotify: (msg: Envelope) => {
        // Standard TanStack Query invalidation
        handleNotify(queryClient, msg)

        // Spawn discovery: invalidate spawn list when spawn_started arrives
        handleSpawnNotify(queryClient, msg)
      },

      onStream: (msg: Envelope) => {
        streaming.handleStreamMessage(msg)
      },

      onControl: (msg: Envelope) => {
        // Forward to streaming client for subscription state updates
        streaming.handleControlMessage(msg)

        // On (re)connect: re-subscribe all active streams
        if (msg.op === CONTROL_RESPONSE_OP.CONNECTED) {
          if (hasConnectedRef.current) {
            // This is a reconnect — re-subscribe with lastSeq/epoch
            streaming.resubscribeAll()
          }
          hasConnectedRef.current = true
        }
      },

      onError: (msg: Envelope) => {
        streaming.handleErrorMessage(msg)
      },
    })
  }, [client, streaming, getToken, queryClient])

  // Connect on mount, destroy on unmount or projectId change
  useEffect(() => {
    hasConnectedRef.current = false
    client.connect()
    return () => {
      streaming.destroy()
      client.destroy()
    }
  }, [client, streaming])

  const contextValue = useMemo<ThreadWsContextValue>(
    () => ({ client, streaming }),
    [client, streaming],
  )

  return (
    <ThreadWsContext.Provider value={contextValue}>
      {children}
    </ThreadWsContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Internal: spawn notify handler
// ---------------------------------------------------------------------------

/**
 * Handle spawn_started notify events by invalidating the parent
 * thread's spawn list query. The auto-subscribe decision is left
 * to the component that knows which thread is currently viewed.
 */
function handleSpawnNotify(
  queryClient: ReturnType<typeof useQueryClient>,
  msg: Envelope,
): void {
  const event = msg.payload?.event
  if (event !== NOTIFY_EVENT.SPAWN_STARTED) return
  if (!msg.resource) return

  // The notify resource is the parent thread
  if (msg.resource.type === RESOURCE_TYPE.THREAD) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.threads.spawns(msg.resource.id),
    })
  }
}

// ---------------------------------------------------------------------------
// Hook: access the context
// ---------------------------------------------------------------------------

/**
 * Access the raw ThreadWsProvider context. Must be used inside
 * a <ThreadWsProvider>. Most consumers should prefer the
 * higher-level hooks (useThreadStreaming, useThreadWsConnection).
 */
export function useThreadWsContext(): ThreadWsContextValue {
  const ctx = useContext(ThreadWsContext)
  if (!ctx) {
    throw new Error(
      "useThreadWsContext must be used within a ThreadWsProvider",
    )
  }
  return ctx
}
