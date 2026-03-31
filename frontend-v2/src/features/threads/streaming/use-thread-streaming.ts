// ═══════════════════════════════════════════════════════════════════
// useThreadStreaming — React hook for thread stream subscriptions.
//
// Bridges React rendering and the imperative StreamingChannelClient.
// Uses useSyncExternalStore for reactive snapshots of subscription
// state without polling or extra re-renders.
//
// Consumers call subscribe/unsubscribe/sendInterjection; the hook
// provides reactive access to activeSubscriptions and connection state.
// ═══════════════════════════════════════════════════════════════════

import { useCallback, useSyncExternalStore } from "react"

import type { ConnectionState } from "@/lib/ws/protocol"

import type {
  StreamingSnapshot,
  SubscribeOptions,
  SubscriptionState,
} from "./streaming-channel-client"
import { useThreadWsContext } from "./ThreadWsProvider"

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UseThreadStreamingResult {
  /** Subscribe to a turn's stream. Returns cleanup function. */
  subscribe: (turnId: string, options?: SubscribeOptions) => () => void
  /** Unsubscribe from a turn's stream. */
  unsubscribe: (turnId: string) => void
  /** Send an interjection to a streaming turn. */
  sendInterjection: (
    turnId: string,
    text: string,
    mode: "append" | "replace",
  ) => void
  /** Active subscriptions (reactive — triggers re-render on change). */
  activeSubscriptions: ReadonlyMap<string, SubscriptionState>
  /** WS connection state (reactive). */
  connectionState: ConnectionState
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for managing thread stream subscriptions.
 *
 * Provides imperative methods (subscribe, unsubscribe, sendInterjection)
 * and reactive state (activeSubscriptions, connectionState) backed by
 * useSyncExternalStore.
 *
 * Must be used inside a `<ThreadWsProvider>`.
 */
export function useThreadStreaming(): UseThreadStreamingResult {
  const { client, streaming } = useThreadWsContext()

  // Reactive snapshot of streaming subscriptions
  const snapshot: StreamingSnapshot = useSyncExternalStore(
    streaming.subscribe,
    streaming.getSnapshot,
  )

  // Reactive connection state from WsClient
  const connectionState: ConnectionState = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
  )

  // Stable callbacks — the streaming client identity is stable per provider
  const subscribe = useCallback(
    (turnId: string, options?: SubscribeOptions) => {
      return streaming.subscribeTurn(turnId, options)
    },
    [streaming],
  )

  const unsubscribe = useCallback(
    (turnId: string) => {
      streaming.unsubscribeTurn(turnId)
    },
    [streaming],
  )

  const sendInterjection = useCallback(
    (turnId: string, text: string, mode: "append" | "replace") => {
      streaming.sendInterjection(turnId, text, mode)
    },
    [streaming],
  )

  return {
    subscribe,
    unsubscribe,
    sendInterjection,
    activeSubscriptions: snapshot.subscriptions,
    connectionState,
  }
}
