# Phase 4: WebSocket Provider

## Goal

Replace the Yjs transport stub with the real document WebSocket provider that matches backend protocol semantics: auth, Yjs sync handshake, heartbeat, reconnect, `AUTH_EXPIRED`, access loss, and `document:restored`.

## Dependencies

- Phase 2 complete
- Phase 3 is not a hard prerequisite for the provider itself, but Phase 3 stories are the easiest place to prove the provider on live views

## Parallelism

- `P4.1` can begin as soon as Phase 2 contracts exist.
- `P4.2` depends on `P4.1`.
- `P4.3` depends on `P4.2`.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P4.1 | Real document WS provider and control-plane event model | High | `gpt-5.4` |
| P4.2 | `DocSession` integrates the provider and reset/reconnect flows | High | `gpt-5.4` |
| P4.3 | Stories and smokeable local verification for reconnect/auth/reset flows | Medium | `gpt-5.4` |

### Step P4.1: Build The Document WS Provider

**Scope and intent**

Implement the real provider boundary that owns the socket, sends raw Yjs protocol bytes, listens for control-plane JSON events, and exposes a clean session-facing contract.

**Files to create or modify**

- `frontend-v2/src/editor/collab/document-ws-provider.ts`
- `frontend-v2/src/editor/collab/yjs-binding.ts` - remove `connectTransport()` stub after the real provider exists
- `frontend-v2/src/editor/collab/document-ws-provider.test.ts`

**Interface contracts**

```ts
export type ProviderControlEvent =
  | { type: "connected" }
  | { type: "auth-expired" }
  | { type: "access-revoked"; status: 403 | 404 }
  | { type: "document-restored" }
  | { type: "rate-limited"; retryAfterMs?: number }
  | { type: "fatal"; code: string; message: string }

export interface DocumentWsProvider {
  connect(): void
  disconnect(reason?: string): void
  sendAwarenessUpdate(update: Uint8Array): void
  onConnectionState(listener: (state: ConnectionState) => void): () => void
  onControlEvent(listener: (event: ProviderControlEvent) => void): () => void
  destroy(): void
}

export type DocumentWsProviderFactory = (args: {
  documentId: string
  ydoc: Y.Doc
  awareness: Awareness
  getAccessToken: () => Promise<string>
}) => DocumentWsProvider
```

**Patterns to follow**

- Follow the transport semantics in `_docs/plans/ws-transport-v2/spec/ws-patterns.md` and `backend-frontend.md`.
- Use `y-protocols/sync` helpers instead of hand-rolled state-vector frames.

**Constraints and boundaries**

- No React in this layer.
- Do not bury control-plane events inside generic error strings.
- Treat `AUTH_EXPIRED` and `document:restored` as first-class events, not retryable noise.

**Verification criteria**

- Unit tests cover connect, heartbeat response, reconnect backoff, auth expiry, rate limiting, and `document:restored`.
- The provider does not re-broadcast its own applied updates.
- The provider exposes state transitions that map cleanly to the design doc's connection state machine.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f _docs/plans/ws-transport-v2/spec/backend-frontend.md
-f _docs/plans/ws-transport-v2/spec/ws-patterns.md
-f backend/internal/handler/collab_document_handler.go
-f frontend-v2/src/editor/collab/yjs-binding.ts
```

### Step P4.2: Integrate Provider Lifecycle Into `DocSession`

**Scope and intent**

Wire the new provider into `DocSession` so reconnect, access revocation, and `document:restored` change session state correctly. This is where session invalidation and local data clearing become real.

**Files to create or modify**

- `frontend-v2/src/editor/session/doc-session.ts`
- `frontend-v2/src/editor/session/session-pool.ts`
- `frontend-v2/src/editor/collab/idb-persistence.ts` if reset flows require stronger clear guarantees
- `frontend-v2/src/editor/persistence/proposal-store.ts`

**Interface contracts**

`DocSession` must now rely on `DocumentWsProvider` from `P4.1` and implement the design-level behaviors:

- `AUTH_EXPIRED` -> refresh token -> reconnect
- `403/404` -> freeze session and route to invalidation UI
- `document:restored` -> destroy current Yjs resources, clear local Yjs/Dexie data for the doc, recreate session cold

**Patterns to follow**

- Preserve the SessionPool generation guard around resets so a stale idle timer cannot destroy a newly recreated session.
- Keep transport-derived `connectionState` distinct from user-facing `syncState`.

**Constraints and boundaries**

- Do not implement proposal diffing here.
- Do not turn `document:restored` into an in-place Yjs mutation. It must be a full teardown/reset.

**Verification criteria**

- Mid-session reconnect merges offline/local edits correctly.
- Access-revoked sessions become frozen and non-editable.
- `document:restored` clears `y-indexeddb` and Dexie state for that doc before recreating the session.

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/session/doc-session.ts
-f frontend-v2/src/editor/session/session-pool.ts
-f frontend-v2/src/editor/collab/document-ws-provider.ts
-f frontend-v2/src/editor/collab/idb-persistence.ts
-f frontend-v2/src/editor/persistence/proposal-store.ts
```

### Step P4.3: Add Verification Stories And Local Smoke Hooks

**Scope and intent**

Expose connection lifecycle states in Storybook for repeatable UI verification, then add the minimum local verification path against the real backend or smoke harness so reconnect/auth/reset behavior is not story-only.

**Files to create or modify**

- `frontend-v2/src/editor/stories/ConnectionLifecycle.stories.tsx`
- `frontend-v2/src/editor/stories/helpers/SimulatedServer.ts` or a provider-specific story helper

**Patterns to follow**

- Keep Storybook focused on client-state transitions and visible behavior.
- Use the real backend or existing smoke harness for the final protocol check, not Storybook alone.

**Constraints and boundaries**

- Do not try to fully fake backend correctness in stories.
- If backend smoke verification is not yet automatable, document the manual verification checklist in the story file comments or phase report.

**Verification criteria**

- Storybook covers `connected`, `reconnecting`, `frozen`, and reset-required flows.
- Local verification proves: two clients see each other's edits, offline edits reconcile on reconnect, auth expiry reconnects, and `document:restored` reloads fresh state.

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/collab/document-ws-provider.ts
-f frontend-v2/src/editor/session/doc-session.ts
-f frontend-v2/src/editor/stories/helpers/SimulatedServer.ts
-f backend/internal/handler/collab_document_handler.go
```
