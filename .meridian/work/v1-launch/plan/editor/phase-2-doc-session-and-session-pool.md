# Phase 2: DocSession + SessionPool Local Persistence

## Goal

Move document ownership out of views and into warm, document-scoped sessions that survive tab switches and temporary detaches. This phase makes local persistence and invalidation real before any per-surface view-controller work begins.

## Dependencies

- Phase 1 complete

## Parallelism

- `P2.1` and `P2.2` can run in parallel.
- `P2.3` depends on both `P2.1` and `P2.2`.
- `P2.4` depends on `P2.3`.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P2.1 | Harden `y-indexeddb` wrapper with health reporting and clear-data support | High | `gpt-5.4` |
| P2.2 | Add Dexie schema for proposals, queued ops, and cache metadata | Medium | `gpt-5.3-codex` |
| P2.3 | Implement `DocSession` as the document-scoped lifecycle owner | High | `gpt-5.4` |
| P2.4 | Implement `SessionPool` with preload, warm budget, generation guards, and invalidation flows | High | `gpt-5.4` |

### Step P2.1: Harden Local Yjs Persistence

**Scope and intent**

Turn `idb-persistence.ts` from a best-effort wrapper into an explicit health-tracked persistence layer. The editor is removing save buttons, so "IDB timed out" cannot still look like success.

**Files to create or modify**

- `frontend-v2/src/editor/collab/idb-persistence.ts`
- `frontend-v2/src/editor/stories/LocalPersistence.stories.tsx` - degraded/healthy persistence harness

**Interface contracts**

```ts
export type LocalPersistenceStatus =
  | "healthy"
  | "degraded"
  | "unavailable"

export interface LocalPersistenceHealth {
  status: LocalPersistenceStatus
  timedOut: boolean
  lastError: Error | null
}

export interface IdbPersistenceHandle {
  provider: IndexeddbPersistence
  synced: Promise<{ timedOut: boolean }>
  getHealth(): LocalPersistenceHealth
  subscribeHealth(listener: (health: LocalPersistenceHealth) => void): () => void
  clearData(): Promise<void>
  destroy(): Promise<void>
}
```

**Patterns to follow**

- Preserve the existing 3-second sync timeout as a signal, not as success.
- Match the "explicit degraded mode" requirement from the design doc.

**Constraints and boundaries**

- Do not couple this wrapper to React.
- Do not add Dexie logic here.

**Verification criteria**

- Unit tests cover sync timeout, open failure, and `clearData()`.
- Storybook includes a degraded state that surfaces "changes are not being saved locally".
- `clearData()` can be used later by invalidation and `document:restored`.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/collab/idb-persistence.ts
-f frontend-v2/src/editor/collab/yjs-binding.ts
```

### Step P2.2: Add The Dexie-backed Editor Database

**Scope and intent**

Create the application-state store that complements `y-indexeddb`. It must persist proposals, queued accept/reject operations, and document cache metadata from day one.

**Files to create or modify**

- `frontend-v2/src/editor/persistence/editor-db.ts`
- `frontend-v2/src/editor/persistence/proposal-store.ts`
- `frontend-v2/src/editor/persistence/editor-db.test.ts`

**Interface contracts**

```ts
export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale"

export interface PersistedProposal {
  proposalId: string
  documentId: string
  yjsUpdate: Uint8Array
  status: ProposalStatus
  createdAt: number
  createdByUserId: string
  regionTextBefore: string
  regionTextAfter: string
  proposedAtOffset: number
  acceptedAtOffset: number | null
}

export interface QueuedProposalOp {
  id: string
  documentId: string
  proposalId: string
  operation: "accept" | "reject"
  enqueuedAt: number
}

export interface DocumentCacheMeta {
  documentId: string
  lastAccessedAt: number
}
```

**Patterns to follow**

- Keep persistence modules headless and composable.
- Use one place to define schema/versioning so later phases do not fork types.

**Constraints and boundaries**

- No diff derivation yet. This step only persists and queries records.
- No websocket sync/drain logic yet.

**Verification criteria**

- Vitest covers insert, update, query by `documentId`, and clear-document flows.
- The schema supports `acceptedAtOffset` and the text snapshot fields from the diff model.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f .meridian/work/v1-launch/features/collab/frontend-diff-model.md
-f frontend-v2/src/editor/collab/undo-manager.ts
```

### Step P2.3: Implement `DocSession`

**Scope and intent**

Create the canonical document-scoped lifecycle object that owns Yjs resources, local persistence, health state, invalidation state, and transport placeholders. It does not own an `EditorView`.

**Files to create or modify**

- `frontend-v2/src/editor/session/doc-session.ts`
- `frontend-v2/src/editor/session/types.ts`
- `frontend-v2/src/editor/collab/yjs-binding.ts` - keep only binding helpers, not session lifecycle ownership

**Interface contracts**

```ts
export type FrozenReason = "document-deleted" | "access-revoked"
export type DocSyncState = "connected" | "local-changes-pending" | "disconnected"
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resetting"

export interface DocSession {
  id: string
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  idbPersistence: IdbPersistenceHandle
  wsProvider: DocumentWsProvider | null
  attachedViewCount: 0 | 1
  generation: number
  lastDetachedAt: number | null
  frozenReason: FrozenReason | null
  hasPendingLocalChanges: boolean
  syncState: DocSyncState
  connectionState: ConnectionState
  destroy(): Promise<void>
}
```

**Patterns to follow**

- Keep document-scoped ownership separate from view-scoped ownership.
- Reuse the origin semantics from `undo-manager.ts`.

**Constraints and boundaries**

- `DocSession` must not cache `EditorState`.
- Do not build lease transfer or tab LRU logic here. That belongs in Phase 3.
- WebSocket provider can stay nullable until Phase 4, but the contract must be present now.

**Verification criteria**

- A session can be created, observed, invalidated, and destroyed without any `EditorView`.
- Local Yjs edits update `hasPendingLocalChanges`.
- IDB health degradation is exposed through the session state.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f .meridian/work/v1-launch/features/editor/editor-collab.md
-f frontend-v2/src/editor/collab/yjs-binding.ts
-f frontend-v2/src/editor/collab/idb-persistence.ts
-f frontend-v2/src/editor/collab/undo-manager.ts
```

### Step P2.4: Implement `SessionPool`

**Scope and intent**

Add the warm-session manager that creates sessions on demand, supports preload, handles idle release, evicts the oldest idle session when the budget is exceeded, and makes invalidation/recovery flows possible.

**Files to create or modify**

- `frontend-v2/src/editor/session/session-pool.ts`
- `frontend-v2/src/editor/session/session-pool.test.ts`
- `frontend-v2/src/editor/stories/SessionPool.stories.tsx`

**Interface contracts**

```ts
export interface SessionPoolOptions {
  idleMs?: number
  warmBudget?: number
  user: AwarenessUserInfo
  wsFactory?: DocumentWsProviderFactory
}

export class SessionPool {
  ensureSession(id: string): Promise<DocSession>
  preload(id: string): Promise<DocSession>
  releaseSession(id: string): void
  invalidateSession(id: string, reason: FrozenReason): Promise<void>
  getSession(id: string): DocSession | null
  subscribe(listener: () => void): () => void
  destroy(): Promise<void>
}
```

**Patterns to follow**

- Follow the generation-guard and atomic-eviction pattern from `_docs/plans/ws-transport-v2/spec/backend-frontend.md`.
- Use immutable snapshots for `subscribe()` consumers.

**Constraints and boundaries**

- No per-surface `activeDocId` logic yet.
- The pool may know whether a doc has an attached live view, but it must not create or destroy views directly.

**Verification criteria**

- Open -> edit -> release -> reopen rehydrates from IDB.
- `preload()` hydrates a warm session without creating a view.
- Warm budget eviction removes the oldest idle session when the cap is exceeded.
- A stale timer cannot destroy a session that has been re-borrowed.
- Invalidated sessions expose a frozen state and can later clear both Yjs IDB and Dexie document rows.
- Storybook demonstrates the warm/cold/invalidation transitions without custom backend code.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f _docs/plans/ws-transport-v2/spec/backend-frontend.md
-f frontend-v2/src/editor/session/doc-session.ts
-f frontend-v2/src/editor/collab/idb-persistence.ts
-f frontend-v2/src/editor/persistence/editor-db.ts
```
