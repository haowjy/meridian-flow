// ═══════════════════════════════════════════════════════════════════
// DocWsProvider — React context for the doc WS connection.
//
// Wraps WsClient for /ws/projects/{projectId}/docs. Routes notify
// events to TanStack Query invalidation. Creates and manages a
// DocStreamClient for document Yjs sync subscriptions. Exposes
// connection state via useDocWsConnection() hook and DocStreamClient
// via useDocStream() hook.
//
// Pattern follows ThreadWsProvider — same lifecycle, same reconnection
// strategy, extended with DocStreamClient for Yjs CRDT sync.
// ═══════════════════════════════════════════════════════════════════

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { ConnectionState, Envelope } from "@/lib/ws/protocol"
import { CONTROL_RESPONSE_OP } from "@/lib/ws/protocol"
import { WsClient, buildWsUrl } from "@/lib/ws/ws-client"
import { DocStreamClient } from "@/lib/ws/doc-stream-client"
import { handleNotify } from "@/lib/ws/notify-handler"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface DocWsContextValue {
  client: WsClient
  streamClient: DocStreamClient
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
 * Mount once at the project layout level. Provides:
 * - Automatic TanStack Query invalidation on notify events
 * - DocStreamClient for subscribing to document Yjs sync streams
 * - Reconnect with re-subscribe of all active document subscriptions
 */
export function DocWsProvider({
  projectId,
  getToken,
  children,
}: DocWsProviderProps) {
  const queryClient = useQueryClient()

  // Track whether we've already been connected at least once,
  // so we can distinguish initial connect from reconnect.
  const hasConnectedRef = useRef(false)

  // Create the WsClient + DocStreamClient once per projectId.
  // getToken is excluded from deps — it's passed via updateCallbacks
  // so WsClient/DocStreamClient aren't recreated on token function
  // identity changes (which would destroy all active subscriptions).
  const { client, streamClient } = useMemo(() => {
    const wsUrl = buildWsUrl(
      `/ws/projects/${encodeURIComponent(projectId)}/docs`,
    )
    const wsClient = new WsClient({
      url: wsUrl,
      getToken,
    })
    const docStreamClient = new DocStreamClient(wsClient)
    return { client: wsClient, streamClient: docStreamClient }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Keep callbacks fresh — runs after render so WsClient always
  // dispatches to the latest handlers without reconnecting.
  useEffect(() => {
    client.updateCallbacks({
      getToken,

      onNotify: (msg: Envelope) => {
        handleNotify(queryClient, msg)
      },

      onStream: (msg: Envelope) => {
        // Route JSON stream events (ended, gap) to DocStreamClient
        streamClient.handleStreamEvent(msg)
      },

      onControl: (msg: Envelope) => {
        // Forward to stream client for subscription state updates
        streamClient.handleControlMessage(msg)

        // On (re)connect: re-subscribe all active document streams
        if (msg.op === CONTROL_RESPONSE_OP.CONNECTED) {
          if (hasConnectedRef.current) {
            // This is a reconnect — re-subscribe fresh (CRDT convergence)
            streamClient.handleReconnect()
          }
          hasConnectedRef.current = true
        }
      },

      onError: (msg: Envelope) => {
        streamClient.handleErrorMessage(msg)
      },

      // Route binary frames to DocStreamClient for Yjs sync/awareness
      onBinaryMessage: (subId: string, data: Uint8Array) => {
        streamClient.handleBinaryMessage(subId, data)
      },
    })
  }, [client, streamClient, getToken, queryClient])

  // Connect on mount, destroy on unmount or projectId change
  useEffect(() => {
    hasConnectedRef.current = false
    client.connect()
    return () => {
      streamClient.destroy()
      client.destroy()
    }
  }, [client, streamClient])

  const contextValue = useMemo<DocWsContextValue>(
    () => ({ client, streamClient }),
    [client, streamClient],
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

/**
 * Access the DocStreamClient for Yjs document sync subscriptions.
 *
 * Used by SessionPool (via useEffect bridge) and directly by
 * components that need to subscribe to document streams.
 *
 * Must be used inside a `<DocWsProvider>`.
 */
export function useDocStream(): { client: DocStreamClient } {
  const ctx = useContext(DocWsContext)
  if (!ctx) {
    throw new Error("useDocStream must be used within a DocWsProvider")
  }

  return { client: ctx.streamClient }
}

/**
 * Optional variant — returns null when no DocWsProvider is in the tree.
 *
 * Used by DocStreamBridge in session-pool-context to avoid crashes in
 * test/storybook contexts where DocWsProvider isn't mounted.
 */
export function useDocStreamOptional(): DocStreamClient | null {
  const ctx = useContext(DocWsContext)
  return ctx?.streamClient ?? null
}
