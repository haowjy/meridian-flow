// ═══════════════════════════════════════════════════════════════════
// useThreadWsConnection — React hook for thread WS connection state.
//
// Thin wrapper around useSyncExternalStore + ThreadWsProvider context.
// Returns the connection state (disconnected/connecting/connected/
// reconnecting) reactively — components re-render only when the
// state actually changes.
// ═══════════════════════════════════════════════════════════════════

import { useSyncExternalStore } from "react"

import type { ConnectionState } from "@/lib/ws/protocol"

import { useThreadWsContext } from "./ThreadWsProvider"

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Read the thread WS connection state reactively.
 *
 * Uses `useSyncExternalStore` so components re-render only when
 * the connection state actually changes — no polling, no extra
 * subscriptions.
 *
 * Must be used inside a `<ThreadWsProvider>`.
 */
export function useThreadWsConnection(): { state: ConnectionState } {
  const { client } = useThreadWsContext()

  const state = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
  )

  return { state }
}
