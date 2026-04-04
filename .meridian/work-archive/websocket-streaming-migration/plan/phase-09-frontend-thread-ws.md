# Phase 9: Frontend ThreadWsProvider + Streaming

## Scope

Build the thread WS frontend: `ThreadWsProvider`, `StreamingChannelClient`, interjection client, and the `useThreadStreaming()` hook. This replaces the SSE-based streaming transport with WS subscriptions, including gap recovery and stream-switch auto-follow.

This is the most complex frontend phase — the `StreamingChannelClient` manages subscriptions, catchup, live events, gap recovery, and reconnection re-subscribe.

## What's Out of Scope

- Removing SSE transport code (Phase 10)
- Removing old `ThreadStoreInterface.connectStream()` / `disconnectStream()` (Phase 10)
- DocWsProvider changes (already done in Phase 8)

## Prerequisites

- **Phase 7** (Thread WS backend endpoint exists for testing)
- **Phase 8** (Shared WS client base `WsClient` and `protocol.ts` types exist; `notify-handler.ts` for TanStack Query invalidation)

## Files to Create

### `frontend-v2/src/features/threads/streaming/streaming-channel-client.ts`

Core streaming client managing subscriptions:

```typescript
interface StreamingChannelClient {
  subscribe(turnId: string, options?: {
    lastSeq?: number
    epoch?: string
    onEvent?: (event: AGUIEvent) => void
    onEnded?: (reason: string, metadata: Record<string, unknown>) => void
    onGap?: (fromSeq: number, toSeq: number, cause: string) => void
  }): () => void  // returns cleanup

  unsubscribe(turnId: string): void
  sendInterjection(turnId: string, text: string, mode: "append" | "replace"): void
  readonly activeSubscriptions: Map<string, SubscriptionState>

  // useSyncExternalStore contract
  subscribe(callback: () => void): () => void
  getSnapshot(): StreamingSnapshot
}
```

**Key implementation details**:

Gap recovery (per [frontend.md](../design/frontend.md) §Gap Recovery):
- Track `gapAttempts` per **turnId** on `StreamingChannelClient`, NOT per subId
- Reset `gapAttempts` to 0 when a stream event is received for that turn
- Two consecutive gap attempts → stop retrying, fall back to REST state
- Check for `stream_switch` via REST (successor discovery on missed `ended{stream_switch}`)

Auto-subscribe behaviors:
- `spawn_started` notify → auto-subscribe to spawn's assistant turn
- `ended{reason: "stream_switch"}` → auto-subscribe to `newAssistantTurnId` from payload
- WS reconnect → re-subscribe all active subscriptions with `{lastSeq, epoch}` from last received event

Subscription state:
- `subId`: client-generated ("s-" + uuid)
- `turnId`: the turn being streamed
- `lastSeq`: last received seq (for reconnect catchup)
- `epoch`: last received epoch (for reconnect catchup)
- `callbacks`: onEvent, onEnded, onGap

### `frontend-v2/src/features/threads/streaming/ThreadWsProvider.tsx`

```tsx
const ThreadWsContext = createContext<ThreadWsClient | null>(null)

function ThreadWsProvider({ projectId, children }: Props) {
  // Create WsClient connected to /ws/projects/{projectId}/threads
  // Create StreamingChannelClient wrapping the WsClient
  // Route notify events to TanStack Query invalidation + spawn auto-subscribe
  // Route stream events to StreamingChannelClient
  // Expose StreamingChannelClient + connection state via context
}
```

### `frontend-v2/src/features/threads/streaming/use-thread-streaming.ts`

```typescript
function useThreadStreaming(threadId: string): {
  subscribe: (turnId: string) => void
  unsubscribe: (turnId: string) => void
  sendInterjection: (turnId: string, text: string, mode: string) => void
  activeSubscriptions: Map<string, SubscriptionState>
  connectionState: ConnectionState
}
```

Uses `useSyncExternalStore` to get reactive snapshots from `StreamingChannelClient`. The hook manages the bridge between React rendering and the imperative WS client.

### `frontend-v2/src/features/threads/streaming/use-thread-ws-connection.ts`

```typescript
function useThreadWsConnection(): {
  state: ConnectionState  // disconnected | connecting | connected | reconnecting
}
```

## Files to Modify

| File | Change |
|------|--------|
| `frontend-v2/src/features/activity-stream/streaming/events.ts` | May need to adapt AG-UI event deserialization from WS envelope format (payload contains the AG-UI event). Verify compatibility. |
| `frontend-v2/src/features/activity-stream/streaming/reducer.ts` | Verify existing reducer handles events from WS provider the same as from SSE. The reducer should be transport-agnostic. |
| Component tree (project layout) | Wrap with `<ThreadWsProvider projectId={projectId}>` at project level. See [frontend.md](../design/frontend.md) §Component Tree. |

## Spawn Discovery via Notify

When `spawn_started` notify arrives:
1. Invalidate spawn list query: `["threads", parentThreadId, "spawns"]`
2. If active thread view, auto-subscribe to spawn's assistant turn

```typescript
function handleSpawnStarted(msg: Envelope, streamingClient: StreamingChannelClient) {
  const { spawnThreadId, spawnTurnId } = msg.payload
  queryClient.invalidateQueries({ queryKey: ["threads", parentThreadId, "spawns"] })
  if (isActiveThreadView(msg.resource.id)) {
    streamingClient.subscribe(spawnTurnId)
  }
}
```

## Stream Switch Flow

When `ended{reason: "stream_switch"}` arrives:
1. The subscription for the old turn ends (framework calls EndSub)
2. Extract `newAssistantTurnId` from payload
3. Auto-subscribe to the new assistant turn
4. Reset gap attempts for the old turn

## Reconnection

On WS reconnect (after `connected` response):
1. Re-subscribe to all active subscriptions
2. For each: send `subscribe` with `lastSeq` and `epoch` from last received event
3. If `gap` response → trigger gap recovery flow
4. If `subscribed` with `recovered: true` → catchup events arrive, then live events resume

## Patterns to Follow

- Phase 8's `WsClient` for connection management
- Existing `DocumentWsProviderImpl` reconnection strategy
- Existing activity stream `reducer.ts` for AG-UI event processing
- `useSyncExternalStore` for reactive state from imperative client

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] `pnpm tsc --noEmit` passes
- [ ] StreamingChannelClient unit tests:
  - Subscribe → receives subscribed + catchup + live events
  - Gap → REST fallback → re-subscribe or terminal
  - Two consecutive gaps → stop retrying (livelock prevention)
  - Stream switch → auto-subscribe to successor
  - Reconnect → re-subscribe all active with lastSeq/epoch
  - Interjection → send message → receive result
- [ ] Integration test (manual or browser-tester):
  - Create a turn via API → subscribe via WS → see AG-UI events render in activity stream
  - Send interjection during streaming → stream switch occurs → new turn events flow
  - Spawn starts → notify arrives → auto-subscribe → see spawn events
  - Disconnect server → reconnect → catchup events arrive → resume live
- [ ] `useThreadStreaming()` hook provides reactive subscription state
- [ ] Activity stream reducer processes WS-delivered events identically to SSE-delivered events

## Agent Staffing

- **Implementer**: `frontend-coder` (default — gap recovery logic is fully specified in blueprint)
- **Reviewers**: 1x correctness review (opus — focus: gap recovery livelock prevention, reconnection re-subscribe ordering, stream switch race conditions), 1x React patterns review (gpt-5.4 — focus: useSyncExternalStore usage, context provider lifecycle, cleanup on unmount)
- **Testing**: `browser-tester` (end-to-end: stream a turn → see events → send interjection → verify stream switch)
- **Verification**: `verifier` (lint + type checks)
