# Phase 12: Frontend DocStreamClient + DocumentWsProvider Rewrite

## Scope

Add `DocStreamClient` to the doc WS provider for Yjs CRDT sync subscriptions. Rewrite `DocumentWsProviderImpl` to use `DocStreamClient` instead of its own per-document WS connection. Update the session injection path so `SessionPool` can pass `DocStreamClient` to the factory.

This is the frontend-heavy phase — new client class, provider rewrite, session wiring.

## Design Reference

- [frontend.md](../design/frontend.md) §DocStreamClient — interface spec
- [frontend.md](../design/frontend.md) §DocumentWsProvider Rewrite — adapter pattern
- [frontend.md](../design/frontend.md) §DocStreamClient Injection Path — SessionPool wiring
- [doc-ws.md](../design/doc-ws.md) §Binary Payload Encoding — base64 encoding convention

## What's In Scope

1. **DocStreamClient class** — manages document stream subscriptions on the doc WS
2. **DocWsProvider update** — expose `DocStreamClient` via context alongside `WsClient`
3. **DocumentWsProviderImpl rewrite** — thin adapter over `DocStreamClient`, no own WS connection
4. **Factory signature change** — `getAccessToken` → `docStreamClient: DocStreamClient`
5. **SessionPool injection** — `setDocStreamClient()` setter, update factory calls
6. **DocSession update** — update provider construction to use new factory signature
7. **Session types update** — `DocumentWsProviderFactory` new signature
8. **Base64 utilities** — `base64ToUint8Array()` / `uint8ArrayToBase64()` for Yjs payloads
9. **`useDocStream()` hook** — expose `DocStreamClient` from context

## What's Out of Scope

- Removing old `document-ws-provider.ts` connection/auth/heartbeat code (Phase 13 — the rewrite replaces it in place)
- Backend changes (Phase 11)
- ThreadWsProvider changes (already done in Phase 9)

## Prerequisites

- Phase 11 (Doc handler Yjs support — backend endpoint handles stream subscriptions)
- Phase 8 (DocWsProvider and WsClient base exist)

## Files to Create

### `frontend-v2/src/lib/ws/doc-stream-client.ts`

```typescript
interface DocStreamClientConfig {
  wsClient: WsClient
}

interface DocSubscribeOptions {
  ydoc: Y.Doc
  awareness: Awareness
  onSyncEvent?: (data: Uint8Array) => void
  onAwarenessEvent?: (data: Uint8Array) => void
  onEnded?: (reason: string) => void
}

interface DocSubscriptionState {
  documentId: string
  subId: string
  connectionState: "subscribing" | "syncing" | "synced"
}

class DocStreamClient {
  subscribe(documentId: string, options: DocSubscribeOptions): () => void
  unsubscribe(documentId: string): void
  sendSyncMessage(documentId: string, data: Uint8Array): void
  sendAwarenessMessage(documentId: string, data: Uint8Array): void
  get activeDocSubscriptions(): Map<string, DocSubscriptionState>

  // Called by WsClient when stream events arrive — dispatch by subId
  handleStreamEvent(msg: Envelope): void

  // Called by WsClient on reconnect — re-subscribe all active docs (fresh, no lastSeq/epoch)
  handleReconnect(): void
}
```

Key behaviors:
- **subscribe**: Generate subId → send `control:subscribe` with `resource: { type: "document", id: documentId }` → wait for `subscribed` → mark syncing → process incoming sync events → mark synced after initial exchange
- **handleStreamEvent**: Route by subId → base64 decode `payload.data` → dispatch by `payload.type` (sync/awareness) → call subscriber callbacks
- **sendSyncMessage**: Base64 encode → send `stream:message` with `resource: { type: "document", id: documentId }` and `payload: { type: "sync", data: base64 }`
- **handleReconnect**: Re-subscribe all active documents with no lastSeq/epoch (CRDT convergence, D38)
- **handleEnded**: Route by subId → call subscriber's onEnded callback → clean up subscription state

### `frontend-v2/src/lib/ws/base64.ts`

```typescript
export function uint8ArrayToBase64(data: Uint8Array): string
export function base64ToUint8Array(base64: string): Uint8Array
```

Use `btoa`/`atob` with binary string conversion, or `TextEncoder`/`TextDecoder` if available. Keep it simple — no external dependencies.

## Files to Modify

### `frontend-v2/src/features/docs/DocWsProvider.tsx`

- Import `DocStreamClient`
- Create `DocStreamClient` instance in `useMemo` alongside `WsClient`
- Wire `WsClient.onStream` callback to `docStreamClient.handleStreamEvent()`
- Wire reconnect to `docStreamClient.handleReconnect()`
- Expose `DocStreamClient` via context:

```typescript
interface DocWsContextValue {
  client: WsClient
  streamClient: DocStreamClient  // NEW
}
```

- Add `useDocStream()` hook:

```typescript
export function useDocStream(): { client: DocStreamClient } {
  const ctx = useContext(DocWsContext)
  if (!ctx) throw new Error("useDocStream must be used within a DocWsProvider")
  return { client: ctx.streamClient }
}
```

### `frontend-v2/src/editor/session/types.ts`

Update factory signature:

```typescript
// Before
export type DocumentWsProviderFactory = (args: {
  documentId: string
  ydoc: Y.Doc
  awareness: Awareness
  getAccessToken: () => Promise<string>
}) => DocumentWsProvider

// After
export type DocumentWsProviderFactory = (args: {
  documentId: string
  ydoc: Y.Doc
  awareness: Awareness
  docStreamClient: DocStreamClient  // replaces getAccessToken
}) => DocumentWsProvider
```

### `frontend-v2/src/editor/session/session-pool.ts`

- Add `docStreamClient` property with setter:

```typescript
private docStreamClient: DocStreamClient | null = null

setDocStreamClient(client: DocStreamClient): void {
  this.docStreamClient = client
}
```

- Remove `getAccessToken` from `SessionPoolConfig` (no longer needed for WS providers)
- Update `createSession()` to pass `docStreamClient` to factory instead of `getAccessToken`:

```typescript
// Before
wsProviderFactory: this.wsFactory,
getAccessToken: this.getAccessToken,

// After
wsProviderFactory: this.wsFactory,
docStreamClient: this.docStreamClient,
```

### `frontend-v2/src/editor/session/doc-session.ts`

- Update `DocSessionConfig`:

```typescript
// Before
wsProviderFactory?: DocumentWsProviderFactory
getAccessToken?: () => Promise<string>

// After
wsProviderFactory?: DocumentWsProviderFactory
docStreamClient?: DocStreamClient  // replaces getAccessToken
```

- Update `initialize()` to pass `docStreamClient` to factory:

```typescript
this.wsProvider = this.wsProviderFactory({
  documentId: this.documentId,
  ydoc: this.ydoc,
  awareness: this.awareness,
  docStreamClient: this.docStreamClient!,
})
```

### `frontend-v2/src/editor/session/session-pool-context.tsx`

- Update the context setup to call `setDocStreamClient()` via a React effect:

```tsx
// In the project layout or wherever SessionPool is provided
const { client: docStreamClient } = useDocStream()
const sessionPool = useSessionPool()

useEffect(() => {
  sessionPool.setDocStreamClient(docStreamClient)
}, [sessionPool, docStreamClient])
```

### `frontend-v2/src/editor/collab/document-ws-provider.ts`

Complete rewrite — thin adapter over `DocStreamClient`:

```typescript
class DocumentWsProviderImpl implements DocumentWsProvider {
  private readonly documentId: string
  private readonly ydoc: Y.Doc
  private readonly awareness: Awareness
  private readonly docStreamClient: DocStreamClient
  private unsubscribe: (() => void) | null = null
  private readonly syncOrigin = Symbol("doc-ws-provider")

  constructor(args: {
    documentId: string
    ydoc: Y.Doc
    awareness: Awareness
    docStreamClient: DocStreamClient
  })

  connect(): void {
    this.unsubscribe = this.docStreamClient.subscribe(this.documentId, {
      ydoc: this.ydoc,
      awareness: this.awareness,
      onSyncEvent: (data) => this.handleSyncPayload(data),
      onAwarenessEvent: (data) => this.handleAwarenessPayload(data),
      onEnded: (reason) => this.handleEnded(reason),
    })
  }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  // ... see frontend.md §DocumentWsProvider Rewrite for full implementation
}
```

Key change: `handleEnded("document_restored")` emits a `document-restored` control event and does NOT auto-reconnect (D41).

Factory change:

```typescript
// Before
export function createDocumentWsProvider(args: ProviderArgs): DocumentWsProvider
// After
export function createDocumentWsProvider(args: {
  documentId: string; ydoc: Y.Doc; awareness: Awareness; docStreamClient: DocStreamClient
}): DocumentWsProvider
```

## Dependencies

- `DocStreamClient` depends on `WsClient` (created in Phase 8)
- `DocWsProvider` creates both `WsClient` and `DocStreamClient`
- `SessionPool` receives `DocStreamClient` via setter from React context
- `DocSession` receives `DocStreamClient` via config from `SessionPool`
- `DocumentWsProviderImpl` receives `DocStreamClient` via factory args from `DocSession`

## Patterns to Follow

- `frontend-v2/src/features/threads/streaming-channel-client.ts` — analogous client class for thread stream subscriptions (subscribe/unsubscribe/handleStreamEvent/handleReconnect)
- `frontend-v2/src/lib/ws/ws-client.ts` — `useSyncExternalStore` pattern for reactive state
- `frontend-v2/src/editor/collab/document-ws-provider.ts` — current Yjs sync protocol usage (y-protocols/sync, y-protocols/awareness imports and usage)

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] `pnpm run format` shows no changes
- [ ] `pnpm tsc --noEmit` passes
- [ ] `DocStreamClient` subscribes to a document → receives sync step 1 → responds with sync step 2
- [ ] Two browser tabs editing same document → changes sync via doc WS (not per-document WS)
- [ ] `useDocStream()` hook returns `DocStreamClient` within `DocWsProvider`
- [ ] `DocumentWsProviderImpl` connects/disconnects via `DocStreamClient` (no own WS)
- [ ] `document_restored` ended event → control event emitted, NO auto-reconnect
- [ ] Doc WS reconnect → all active document subscriptions re-subscribed fresh
- [ ] `SessionPool.setDocStreamClient()` correctly propagates to factory
- [ ] No `getAccessToken` references remain in session module (grep verification)
- [ ] No direct WS connection code remains in `document-ws-provider.ts`

## Agent Staffing

- **Implementer**: `frontend-coder` — new client class + provider rewrite + session injection wiring
- **Reviewers**: 2x
  - 1x design alignment (focus: conformance with [frontend.md](../design/frontend.md) §DocStreamClient and §DocumentWsProvider Rewrite)
  - 1x code quality (focus: React context patterns, cleanup on unmount, base64 correctness, y-protocols usage)
- **Testing**: `browser-tester` (verify Yjs sync works between two browser tabs via doc WS)
- **Verification**: `verifier` (lint + type checks)
