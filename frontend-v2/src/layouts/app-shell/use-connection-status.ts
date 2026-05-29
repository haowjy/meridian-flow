import { useSyncExternalStore } from "react"

import type { ConnectionState } from "@/lib/ws/protocol"
import { useThreadWsContext } from "@/features/threads/streaming/ThreadWsProvider"

type StoreSubscribe = (onStoreChange: () => void) => () => void

const noopSubscribe: StoreSubscribe = () => () => {}
const disconnectedSnapshot = (): ConnectionState => "disconnected"

/**
 * Reads the thread WS connection state for StatusBar and BottomNav.
 *
 * Safe to call outside ThreadWsProvider — defaults to disconnected.
 * useThreadWsContext internally calls useContext which always runs;
 * the throw is caught so the hook count stays constant.
 */
export function useConnectionStatus(): {
  connected: boolean
  state: ConnectionState
} {
  let subscribe: StoreSubscribe = noopSubscribe
  let getSnapshot = disconnectedSnapshot

  // useThreadWsContext calls useContext (always runs), then throws if null.
  // The hook call count is stable — try-catch catches the post-hook throw.
  try {
    const ctx = useThreadWsContext()
    // WsClient.subscribe and .getSnapshot are arrow-property class fields
    // with stable identity per instance — safe for useSyncExternalStore.
    subscribe = ctx.client.subscribe
    getSnapshot = ctx.client.getSnapshot
  } catch {
    // Outside ThreadWsProvider — use noop defaults
  }

  const state = useSyncExternalStore(subscribe, getSnapshot)

  return {
    connected: state === "connected",
    state,
  }
}
