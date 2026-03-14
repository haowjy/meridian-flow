# Phase 3: Frontend — Per-document WebSocket migration

You are implementing Phase 3 of the ws-transport-v2 plan. This phase migrates the frontend from the old multiplexed project WebSocket (binary+JSON on one connection) to the new transport split:
- **Project WS** (`/ws/projects/{projectId}`) — JSON only (proposals, heartbeat)
- **Document WS** (`/ws/documents/{documentId}`) — binary only (Yjs sync, awareness)

## Current Frontend Architecture

The current frontend routes everything through a single project WS connection:
1. `useProjectCollab.ts` creates a WS connection to `/ws/projects/{projectId}`
2. It handles both binary frames (Yjs sync via envelope framing) and JSON events (proposals, subscription acks)
3. `useDocumentCollab.ts` subscribes/unsubscribes documents through the project WS using `doc:subscribe`/`doc:unsubscribe`
4. Binary frames are wrapped in envelope format: `[envelope(1)][documentId(16)][payload(n)]`
5. `documentSubscriptionDebounce.ts` handles React StrictMode double-mount

## What Needs to Change

### High-level: Split transport responsibilities

- **Project WS** keeps: proposal events (proposal:statusChanged, proposal:new, proposal:groupAcceptResult, proposal:updateData), heartbeat
- **Project WS** loses: doc:subscribe/unsubscribe protocol, binary frame handling, envelope framing
- **Document WS** (new): Each document gets its own WebSocket connection to `/ws/documents/{documentId}`. This handles Yjs sync (SyncStep1/2/Update) using raw 1-byte prefix protocol (no envelope).

### 1. Create `DocumentSessionManager` — new file

**Path**: `frontend/src/core/cm6-collab/sync/DocumentSessionManager.ts`

Manages per-document WebSocket connections with a warm pool for switching between documents.

```typescript
interface DocumentSession {
  documentId: string
  ws: WebSocket
  runtime: CollabSyncRuntime
  status: 'connecting' | 'authenticating' | 'syncing' | 'connected' | 'disconnected'
}

class DocumentSessionManager {
  private sessions: Map<string, DocumentSession>
  private activeSessionId: string | null

  constructor(private getAuthToken: () => Promise<string>)

  // Acquire a session for a document. Creates WS if needed, reuses if warm.
  acquire(documentId: string): DocumentSession

  // Release a session (move to warm pool or close after timeout)
  release(documentId: string): void

  // Status callbacks
  onStatusChange(documentId: string, callback: (status) => void): () => void

  // Cleanup
  destroy(): void
}
```

Key behaviors:
- Opens WebSocket to `/ws/documents/{documentId}` (relative to API base URL)
- Auth: sends JWT token as first message (same pattern as project WS)
- Binary protocol: raw 1-byte prefix (no envelope). SyncStep1/2/Update/Awareness use lib0 sync protocol directly.
- Reconnect with exponential backoff on disconnect
- The warm pool is optional/future — for now, just create/destroy connections on acquire/release

### 2. Modify `runtime.ts` — remove envelope wrapping

**Path**: `frontend/src/core/cm6-collab/sync/runtime.ts`

The runtime currently uses envelope framing (`frameEnvelope`, `unwrapEnvelope`). Remove this:

- `startSync()` currently calls `frameEnvelope(EnvelopeType.SyncStep1, documentId, ...)`. Change to send raw sync protocol bytes directly (no envelope).
- `handleBinaryFrame(frame)` currently calls `unwrapEnvelope(frame)` to extract documentId and payload. Change to process the frame directly as raw sync protocol bytes (the documentId is implicit — each document has its own WS connection).
- Remove all imports of `envelope.ts` functions.
- Remove `documentId` parameter from constructor/methods if it was only used for envelope framing. Actually, `documentId` is still needed for logging — keep it but don't use it in framing.
- The update handler that sends outbound updates: remove envelope wrapping, send raw sync protocol bytes.

### 3. Modify `useDocumentCollab.ts` — use DocumentSessionManager

**Path**: `frontend/src/features/documents/hooks/useDocumentCollab.ts`

Replace the current pattern of:
- Creating Y.Doc + IndexedDB provider + CollabSyncRuntime manually
- Subscribing to document via project WS transport
- Handling subscription lifecycle

With:
- Acquiring a session from DocumentSessionManager
- The session provides the runtime (Y.Doc, ytext, extensions)
- Release on unmount

Key changes:
- Remove `subscribeDocument`/`unsubscribeDocument` calls to project WS transport
- Remove `pendingBinaryFrames` buffer (no longer needed — each doc has its own WS)
- Remove subscription debounce logic (no more debounce needed)
- Keep proposal event handling via project WS transport (proposals are JSON, still on project WS)
- Keep IndexedDB persistence pattern (or move to DocumentSessionManager)
- Connection state comes from DocumentSessionManager instead of subscription acks

### 4. Modify `useProjectCollab.ts` — remove binary/subscription handling

**Path**: `frontend/src/features/documents/hooks/useProjectCollab.ts`

Remove from `ProjectCollabTransport`:
- `subscribeDocument(documentId)` — no more subscription protocol
- `unsubscribeDocument(documentId)` — no more subscription protocol
- `sendDocumentBinary(documentId, frame)` — no more binary on project WS
- `activeSubscriptions` / `subscribedDocuments` tracking
- Binary message handling in WS onmessage
- Subscription replay on reconnect
- `pendingBinaryFrames` buffering

Keep:
- WS connection lifecycle (connect, auth, reconnect)
- JSON message handling (proposals, heartbeat)
- `registerDocumentListener(documentId, listener)` for proposal events
- `sendDocumentCommand(documentId, command)` for proposal commands (accept/reject/groupAccept/requestUpdate)
- Heartbeat handling

The transport interface becomes:
```typescript
interface ProjectCollabTransport {
  registerDocumentListener(documentId: string, listener: ProjectCollabDocumentListener): () => void
  sendDocumentCommand(documentId: string, command: object): void
  isConnected(): boolean
}
```

### 5. Delete files

- `frontend/src/core/cm6-collab/sync/envelope.ts` — no longer needed (raw protocol)
- `frontend/src/features/documents/hooks/documentSubscriptionDebounce.ts` — no longer needed (no subscription)

### 6. Update `ProjectCollabContext.tsx`

**Path**: `frontend/src/features/documents/contexts/ProjectCollabContext.tsx`

Add DocumentSessionManager to the context so document components can acquire sessions:
- Create DocumentSessionManager in the provider
- Pass both ProjectCollabTransport and DocumentSessionManager through context
- Clean up DocumentSessionManager on unmount

### 7. Update `useCollabStore.ts`

**Path**: `frontend/src/features/documents/stores/useCollabStore.ts`

Connection state now comes from DocumentSessionManager, not subscription acks:
- Keep the store shape (stateByDocumentId, proposalStateByDocumentId)
- Update state updates to source from DocumentSessionManager status callbacks

## Important Constraints

- Must build: `pnpm run build` must pass (includes `tsc --noEmit`)
- Must lint: `pnpm run lint` must pass
- Keep all proposal functionality working — proposals are still on project WS
- Keep IndexedDB persistence pattern for offline-first
- The project WS still uses the old `golang.org/x/net/websocket` library (backend unchanged)
- The document WS uses `coder/websocket` (new backend handler from Phase 1A)
- Auth token: use the Supabase auth session token, same as current project WS auth

## Auth Token Access

The current project WS gets its auth token from Supabase. Look at how `useProjectCollab.ts` gets the token and replicate the same pattern for DocumentSessionManager. It likely uses `supabase.auth.getSession()` or similar.

## API Base URL

The document WS endpoint is at the same backend as the project WS. The base URL pattern should match. Look at how the project WS URL is constructed and follow the same pattern for document WS.

## Verification

1. `cd frontend && pnpm run build` — must pass
2. `cd frontend && pnpm run lint` — must pass
3. Review the TypeScript types — no `any` leaks, proper typing

## Reference Files

Read these before making changes:
- `frontend/src/features/documents/hooks/useProjectCollab.ts` — main transport file
- `frontend/src/features/documents/hooks/useDocumentCollab.ts` — per-document hook
- `frontend/src/core/cm6-collab/sync/runtime.ts` — Yjs sync runtime
- `frontend/src/core/cm6-collab/sync/envelope.ts` — to understand current framing (being deleted)
- `frontend/src/features/documents/hooks/documentSubscriptionDebounce.ts` — being deleted
- `frontend/src/features/documents/contexts/ProjectCollabContext.tsx` — context provider
- `frontend/src/features/documents/stores/useCollabStore.ts` — collab state store
- `frontend/src/core/cm6-collab/proposals/runtime.ts` — proposal manager
- `frontend/src/core/cm6-collab/proposals/contracts.ts` — proposal event types
- `frontend/CLAUDE.md` — frontend conventions
