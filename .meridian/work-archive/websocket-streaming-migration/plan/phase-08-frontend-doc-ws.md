# Phase 8: Frontend WS Base + DocWsProvider

## Scope

Build the shared WebSocket client base and the first provider component (DocWsProvider). The shared base handles connection management, auth, heartbeat, reconnection, and protocol envelope parsing. DocWsProvider is the simpler consumer — notify lane only, validates the base before Thread WS streaming adds complexity.

Includes:
1. **Shared WS client base** — connection state machine, auth bootstrap, heartbeat pong, reconnection with exponential backoff + jitter, protocol envelope dispatch by `kind`
2. **DocWsProvider** — React context provider wrapping the WS client for `/ws/projects/{projectId}/docs`
3. **Notify → TanStack Query invalidation** for doc/proposal events
4. **`useDocWsConnection()` hook** — exposes connection state

## What's Out of Scope

- ThreadWsProvider and StreamingChannelClient (Phase 9)
- Removing old project WS frontend code (Phase 10)
- Any backend changes

## Prerequisites

- **Phase 6** (Doc WS backend endpoint exists to test against)

## Files to Create

### `frontend-v2/src/lib/ws/ws-client.ts`

Shared WS client base. Both DocWsProvider and ThreadWsProvider use this.

```typescript
type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting"

interface WsClientConfig {
  url: string
  getToken: () => Promise<string>  // JWT provider
  onNotify?: (msg: Envelope) => void
  onStream?: (msg: Envelope) => void
  onControl?: (msg: Envelope) => void
  onError?: (msg: Envelope) => void
  onStateChange?: (state: ConnectionState) => void
}

class WsClient {
  connect(): void
  disconnect(): void
  send(msg: Envelope): void
  get state(): ConnectionState

  // useSyncExternalStore contract
  subscribe(callback: () => void): () => void
  getSnapshot(): ConnectionState
}
```

State machine: `disconnected` → `connecting` → `connected` → `reconnecting` → `connecting` → ...

Auth bootstrap: on connect, send `{ kind: "control", op: "auth", payload: { token: jwt } }`. Wait for `connected` response.

Heartbeat: on `ping`, respond with `pong`.

Reconnection: exponential backoff with jitter matching existing `DocumentWsProviderImpl`:
- Base delay: 250ms, max: 5000ms, min: 100ms
- Jitter: ±15%
- Formula: `min(maxDelay, baseDelay * 2^attempt) ± jitter`

### `frontend-v2/src/lib/ws/protocol.ts`

TypeScript types matching the wire protocol:

```typescript
interface Envelope {
  kind: "control" | "notify" | "stream" | "error"
  op: string
  resource?: { type: string; id: string }
  subId?: string
  seq?: number
  epoch?: string
  payload?: Record<string, unknown>
}
```

### `frontend-v2/src/lib/ws/notify-handler.ts`

Shared notify → TanStack Query invalidation mapping:

```typescript
function getInvalidationKeys(resourceType: string, resourceId: string, event: string): QueryKey[]
function handleNotify(queryClient: QueryClient, msg: Envelope): void
```

Key mapping per [frontend.md](../design/frontend.md) §TanStack Query Invalidation:
- `turn` → `["turns", id]`, `["turns", id, "blocks"]`
- `thread` → `["threads", id]`, `["threads", id, "turns"]`
- `proposal` → `["proposals", id]`, `["proposals"]`
- `document` → `["documents", id]`

### `frontend-v2/src/features/docs/DocWsProvider.tsx`

```tsx
const DocWsContext = createContext<DocWsClient | null>(null)

function DocWsProvider({ projectId, children }: Props) {
  // Create WsClient connected to /ws/projects/{projectId}/docs
  // Route notify events to TanStack Query invalidation
  // Expose connection state via context
}

function useDocWsConnection(): { state: ConnectionState }
```

## Patterns to Follow

- Existing `DocumentWsProviderImpl` in `frontend-v2/src/editor/collab/document-ws-provider.ts` — same state machine, same reconnection strategy, adapted for generic protocol envelope
- TanStack Query invalidation patterns already used elsewhere in the frontend

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] `pnpm run format` shows no changes (code is formatted)
- [ ] `pnpm tsc --noEmit` passes (type checks)
- [ ] WsClient unit tests:
  - Connection lifecycle: connect → auth → connected → heartbeat → disconnect
  - Reconnection: disconnect → exponential backoff → reconnect → re-auth
  - State transitions: all valid transitions, no invalid ones
  - Envelope parsing: valid messages dispatched to correct handlers
- [ ] DocWsProvider integration test (or manual verification):
  - Mount DocWsProvider with valid projectId → connection established
  - Receive notify event → corresponding TanStack Query key invalidated
  - Server disconnects → reconnection with backoff
  - Unmount → clean disconnect
- [ ] `useDocWsConnection()` returns reactive connection state

## Agent Staffing

- **Implementer**: `frontend-coder` (the WsClient is the architectural foundation for all frontend WS work)
- **Reviewers**: 1x design alignment review (focus: protocol conformance with [frontend.md](../design/frontend.md), reconnection strategy matches spec), 1x code quality review (focus: React context patterns, useSyncExternalStore usage, cleanup on unmount)
- **Testing**: `browser-tester` (verify WS connection works in real browser against running backend)
- **Verification**: `verifier` (lint + type checks)
