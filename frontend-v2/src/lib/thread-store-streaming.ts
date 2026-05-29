// ═══════════════════════════════════════════════════════════════════
// Thread store streaming bridge — connects Zustand store to WS streams.
//
// Subscribes to turn streams via StreamingChannelClient, routes
// AG-UI events to the store's applyStreamEvent, and handles stream
// end (including stream_switch auto-follow).
//
// Usage: call subscribeToStream() after sendMessage() to start
// receiving events. The subscription is automatically cleaned up
// on stream end or manual unsubscribe.
// ═══════════════════════════════════════════════════════════════════

import type { StreamingChannelClient } from "@/features/threads/streaming/streaming-channel-client"

import { useThreadStore } from "./thread-store"

/**
 * Subscribe to a turn's stream and route events to the thread store.
 *
 * Returns an unsubscribe function. The subscription also auto-cleans
 * when the stream ends (RUN_FINISHED, RUN_ERROR, or stream_switch).
 */
export function subscribeToStream(
  streaming: StreamingChannelClient,
  turnId: string,
): () => void {
  return streaming.subscribeTurn(turnId, {
    onEvent: (event) => {
      useThreadStore.getState().applyStreamEvent(turnId, event)
    },
    onEnded: (reason, payload) => {
      useThreadStore.getState().handleStreamEnded(turnId, reason, payload)
    },
    onGap: (fromSeq, toSeq, cause) => {
      console.warn(
        `[thread-store-streaming] gap on turn ${turnId}: ${fromSeq}→${toSeq} (${cause})`,
      )
    },
  })
}
