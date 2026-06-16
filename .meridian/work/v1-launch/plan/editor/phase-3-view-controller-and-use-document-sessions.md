# Phase 3: ViewController + useDocumentSessions

## Goal

Replace the current tab-owned lifecycle with per-surface controllers that borrow shared `DocSession`s from the pool, enforce the one-live-view-per-doc rule, and let Studio and Converse keep independent active documents. Support both independent and mirrored surface coordination via a layout-level hook.

## Dependencies

- Phase 2 complete

## Parallelism

- `P3.1` must land first (ViewController + `acquireLease` on SessionPool).
- `P3.2` depends on `P3.1`.
- `P3.3` depends on `P3.1` and partially on `P3.2`; it should run after the hook contract is stable.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P3.1 | New `ViewController` replaces `TabManager` as the surface lifecycle owner; `SessionPool.acquireLease()` added | High | `gpt-5.4` |
| P3.2 | `useDocumentSessions()` wraps one controller and a shared pool; `useFollowActiveDoc` coordination hook | Medium | `gpt-5.3-codex` |
| P3.3 | Stories and awareness lifecycle prove lease transfer, hide/evict restore, epoch serialization, and no ghost cursors | High | `gpt-5.4` |

### Step P3.1: Build `ViewController` + Add `acquireLease` to SessionPool

**Scope and intent**

Salvage the useful DOM-host and LRU ideas from `tabs/tab-manager.ts`, but move them into a per-surface controller that never owns Yjs lifecycle. Hidden views remain mounted for fast switches; evicted views destroy only the `EditorView` and keep the underlying `DocSession` warm in the pool.

ViewController creates EditorViews directly using `createEditorExtensions()` + `new EditorView()` — the same imperative path `Editor.tsx` uses internally. The React `<Editor>` component remains for simple single-doc use cases (stories, embeds). ViewController does not render `<Editor>`.

ViewController owns per-doc display metadata (`name`, `isModified`) and exposes `rename`/`setModified` mutators. DocSession stays metadata-free.

Add `SessionPool.acquireLease(id)` to protect sessions during lease transfer. A leased session is excluded from idle-timer eviction AND budget eviction until the lease is released (or safety-times-out).

**Files to create or modify**

- `frontend-v2/src/editor/session/view-controller.ts` — new
- `frontend-v2/src/editor/session/session-pool.ts` — add `acquireLease()`
- `frontend-v2/src/editor/session/view-controller.test.ts` — new
- `frontend-v2/src/editor/tabs/tab-manager.ts` — keep as-is for now (stories still reference it); delete in P3.3 after migration

**Interface contracts**

```ts
export interface ScrollSnapshot {
  scrollTop: number
  scrollLeft: number
}

export interface ViewRestoreState {
  scroll: ScrollSnapshot | null
  selection: Y.RelativePosition | null
}

export interface DocHandle {
  id: string
  name: string
}

export interface OpenDoc {
  id: string
  name: string
  isModified: boolean
}

export interface ViewControllerOptions {
  surfaceId: string
  sessionPool: SessionPool
  maxLive?: number              // default 6
  createEditorView(args: {
    session: DocSession
    container: HTMLDivElement
    restore?: ViewRestoreState | null
  }): EditorView
}

export class ViewController {
  // --- Lifecycle ---
  setHost(el: HTMLDivElement | null): void
  activate(doc: DocHandle): Promise<EditorView | null>  // open-or-switch, serialized
  close(id: string): Promise<void>
  destroy(): Promise<void>

  // --- Metadata (ViewController-owned, not DocSession) ---
  rename(id: string, name: string): void
  setModified(id: string, modified: boolean): void

  // --- Read ---
  getActiveDocId(): string | null
  getActiveView(): EditorView | null
  getOpenDocuments(): OpenDoc[]

  // --- Subscription (useSyncExternalStore-compatible) ---
  subscribe(listener: () => void): () => void
  getSnapshot(): ViewControllerSnapshot
}

export interface ViewControllerSnapshot {
  activeDocId: string | null
  openDocs: OpenDoc[]
}
```

**Key design decisions**

1. **Single `activate(doc)` replaces `open`/`switchTo`.** The caller always passes `{ id, name }`. ViewController checks if the doc is already open (switch) or new (open). This makes mirrored-mode coordination trivial — the follower always has enough info.

2. **Epoch-based async serialization.** ViewController maintains an internal `operationEpoch: number`. Each `activate()` call increments it, captures the value, and after each `await` (e.g. `pool.ensureSession()`) checks if the epoch is still current. Stale operations bail. This prevents rapid A→B→C switches from resolving out of order. Note: if an intermediate activation resolves synchronously (warm session), it will briefly mount before the next one starts — at most a single-frame flash.

3. **Lease transfer via view-owner registry + `acquireLease`.** SessionPool maintains a view-owner registry: `(docId → { surfaceId, detachCallback })`. When `activate()` detects the pool has a registered view owner for the target doc on a different surface:
   - Calls `pool.acquireLease(id)` → marks session non-evictable
   - Calls `pool.requestTransfer(id, surfaceId)` → pool invokes the current owner's `detachCallback` synchronously. The old controller hides/destroys its view, clears cursor awareness, and calls `pool.unregisterViewOwner(id, oldSurfaceId)`.
   - New controller creates EditorView, calls `pool.registerViewOwner(id, surfaceId, detachCb)`, releases the lease.
   - Lease has a safety timeout (5s) that auto-releases if the transfer stalls.
   - If `pool.destroy()` is called during an active lease, the pool sets `destroyed = true` first (invalidating all leases), then tears down. `activate()` re-checks `destroyed` after each await and aborts.

4. **EditorView creation is imperative, not React.** ViewController calls `createEditorExtensions()` + `new EditorView()` directly, the same way `Editor.tsx` does internally. The `createEditorView` callback provided by the consumer (hook in P3.2) is responsible for including all extensions: word count, compartments for readOnly/placeholder/livePreview, etc. The React `<Editor>` component remains for simple single-doc use cases. EditorContextMenu is rendered as a React sibling to the host container by the hook, not by the ViewController.

**SessionPool additions for P3.1**

```ts
// View-owner registry — tracks which surface owns the live view per doc
registerViewOwner(id: string, surfaceId: string, detachCb: () => void): void
unregisterViewOwner(id: string, surfaceId: string): void
requestTransfer(id: string, newSurfaceId: string): void  // calls current owner's detachCb

// Lease — non-evictable during transfer
acquireLease(id: string): () => void   // returns releaseLease function

// acquireLease behavior:
// - Increments session.generation (cancels pending idle timers)
// - Sets a lease flag that excludes the session from idle AND budget eviction
// - Returns a release function that clears the flag
// - Safety timeout (5s): auto-releases if releaseLease() is never called
// - Throws if session doesn't exist or is frozen
// - pool.destroy() invalidates all active leases before teardown
```

**Patterns to follow**

- Reuse the current CSS show/hide and `requestMeasure()` behavior from `tab-manager.ts`.
- Restore from current `session.ytext`, not cached `EditorState`.
- `createEditorView` callback must include: `createEditorExtensions()`, word count extension, compartments for runtime reconfiguration. See `Editor.tsx` for the canonical setup.
- EditorContextMenu is a React concern — hook renders it alongside the host div, not inside ViewController.

**Constraints and boundaries**

- A `ViewController` may keep only view-local restore hints: scroll and optional `Y.RelativePosition`.
- Do not let it create/destroy `DocSession`s directly. All document ownership flows through `SessionPool`.
- Do not render the React `<Editor>` component. Create EditorViews imperatively.

**Verification criteria**

- [ ] LRU view eviction destroys only `EditorView` resources
- [ ] Restoring an evicted doc rebuilds from the latest `Y.Text`
- [ ] Closing the last visible view releases the session back to the pool
- [ ] Rapid A→B→C `activate()` calls resolve to C (epoch guard)
- [ ] Lease transfer: session is not evictable during the transfer window
- [ ] Lease safety timeout auto-releases after 5s
- [ ] `rename()` and `setModified()` update `getOpenDocuments()` snapshot
- [ ] Unit tests pass: `pnpm vitest run view-controller`
- [ ] Type check: `pnpm tsc --noEmit`

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/plan/editor/phase-3-view-controller-and-use-document-sessions.md
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/tabs/tab-manager.ts
-f frontend-v2/src/editor/session/session-pool.ts
-f frontend-v2/src/editor/session/doc-session.ts
-f frontend-v2/src/editor/extensions.ts
-f frontend-v2/src/editor/Editor.tsx
```

### Step P3.2: Add `useDocumentSessions()` And Shared Pool Wiring

**Scope and intent**

Provide the React API that Studio and Converse will consume. The hook owns one controller instance, exposes the current open-doc snapshot plus reactive session state, and reaches into a shared `SessionPool` supplied above the surface.

**Files to create or modify**

- `frontend-v2/src/editor/session/useDocumentSessions.ts`
- `frontend-v2/src/editor/session/session-pool-context.tsx`
- `frontend-v2/src/editor/session/useFollowActiveDoc.ts` — coordination hook
- `frontend-v2/src/editor/TabbedEditorShell.tsx` — align prop naming with new hook result

**Interface contracts**

```ts
export interface ActiveSessionSnapshot {
  syncState: DocSyncState
  connectionState: ConnectionState
  frozenReason: FrozenReason | null
  idbHealth: LocalPersistenceHealth
}

export interface UseDocumentSessionsResult {
  hostRef: React.RefCallback<HTMLDivElement>
  activeDocId: string | null
  openDocs: OpenDoc[]
  activeSessionSnapshot: ActiveSessionSnapshot | null

  // Commands
  activate(doc: DocHandle): void         // fire-and-forget wrapper around controller.activate()
  close(id: string): void
  rename(id: string, name: string): void
  setModified(id: string, modified: boolean): void

  // Imperative escape hatches (documented as non-reactive)
  getActiveView(): EditorView | null
  getSession(id: string): DocSession | null  // for proposal pipeline, ytext access
}
```

**Surface coordination pattern**

The hook is mode-agnostic — it exposes commands without knowing who drives them. Coordination strategy lives in the layout:

- **Independent** (default): Each layout drives its own hook directly.
- **Mirrored**: Layout wires Converse's hook to follow Studio's active doc.

```tsx
// useFollowActiveDoc.ts — optional layout-level coordination hook.
// Takes memoized primitives, not the full result object, to avoid dep instability.
export function useFollowActiveDoc(
  sourceActiveDocId: string | null,
  sourceOpenDocs: OpenDoc[],
  targetActivate: (doc: DocHandle) => void,  // must be useCallback-memoized
) {
  const sourceDoc = sourceOpenDocs.find(d => d.id === sourceActiveDocId)
  useEffect(() => {
    if (sourceDoc) {
      targetActivate({ id: sourceDoc.id, name: sourceDoc.name })
    }
  }, [sourceDoc?.id, sourceDoc?.name, targetActivate])
}
```

Dependencies are primitives + a memoized function — no object-identity instability. The ViewController's internal epoch counter handles rapid source changes — stale activations bail after each await. Note: if an intermediate activation resolves synchronously (warm session), it will briefly mount before the next one starts. React batches same-cycle effects, so this is at most a single-frame flash.

Do NOT add mode flags or coordination logic to the hook or controller. The layout picks the strategy by calling (or not calling) `useFollowActiveDoc`.

**`activeSessionSnapshot` design**

The hook subscribes to both the ViewController (for `activeDocId`/`openDocs`) and the active DocSession (for sync/connection/health state). When `activeDocId` changes, the hook re-subscribes to the new session. This provides reactive access to session state without consumers needing to manage nested subscriptions.

**Patterns to follow**

- Reuse `useSyncExternalStore` from the current `useTabManager.ts`.
- Keep the hook thin. Controller and pool stay headless/testable.

**Constraints and boundaries**

- Do not embed layout-specific assumptions or coordination mode logic in the hook.
- Keep the shared pool in context or another top-level singleton-style wrapper. Do not recreate it per hook call.
- The hook must be usable in both independent and mirrored modes without changes to its API.

**Verification criteria**

- [ ] Two hook instances can point at the same pool without duplicating sessions
- [ ] Snapshot updates are tear-free
- [ ] Unmounting a surface destroys only its controller, not the shared pool
- [ ] `activeSessionSnapshot` updates when the active session's state changes
- [ ] `activeSessionSnapshot` switches when `activeDocId` changes
- [ ] `useFollowActiveDoc` can make one hook follow another's active doc
- [ ] `activate()` from mirrored hook can open a doc the target has never seen
- [ ] Type check: `pnpm tsc --noEmit`

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/plan/editor/phase-3-view-controller-and-use-document-sessions.md
-f frontend-v2/src/editor/session/view-controller.ts
-f frontend-v2/src/editor/session/session-pool.ts
-f frontend-v2/src/editor/tabs/useTabManager.ts
-f frontend-v2/src/editor/TabbedEditorShell.tsx
```

### Step P3.3: Migrate Stories And Implement Awareness Lifecycle Rules

**Scope and intent**

Prove the new lifecycle with Storybook. This is the step that should catch lease transfer mistakes, stale restore bugs, epoch serialization issues, and ghost cursors before transport/proposal work piles on.

**Files to create or modify**

- `frontend-v2/src/editor/collab/awareness-lifecycle.ts` — new
- `frontend-v2/src/editor/stories/CollabTabs.stories.tsx` — rewrite to use `useDocumentSessions`
- `frontend-v2/src/editor/TabbedEditor.stories.tsx` — rewrite
- `frontend-v2/src/editor/tabs/tab-manager.ts` — delete (or keep if other stories still reference)
- `frontend-v2/src/editor/tabs/useTabManager.ts` — delete
- `frontend-v2/src/editor/stories/helpers/CollabEditor.tsx` — update if needed

**Interface contracts**

```ts
/**
 * Clear only the cursor field from awareness.
 * Preserves the `user` identity so remote peers don't see a leave/rejoin flash.
 * Never call awareness.setLocalState(null) — that emits a removal event.
 */
export function clearCursorAwareness(awareness: Awareness): void

/**
 * yCollab automatically publishes cursor/selection on view creation,
 * so no manual publish is needed on restore/show. This function exists
 * for cases where we need to force-republish (e.g., after a view
 * is CSS-shown and receives focus).
 */
export function refreshCursorAwareness(
  awareness: Awareness,
  view: EditorView,
): void
```

**Awareness lifecycle rules**

- On **view hide** (CSS tab switch): `clearCursorAwareness(awareness)` — clears cursor field only, user identity persists.
- On **view eviction** (EditorView destroyed): `clearCursorAwareness(awareness)` — cursor cleared, user identity persists as long as session is alive.
- On **lease transfer**: `clearCursorAwareness(awareness)` on old surface, then new surface creates EditorView which auto-publishes cursor via yCollab.
- On **view show/restore**: call `refreshCursorAwareness(awareness, view)` after the view is focused. `yCollab` only writes cursor from the view's `update()` path when focused — there is no constructor-time publish.

**Key:** `awareness.setLocalStateField('cursor', null)` clears cursor without triggering a "user left" event. The `user` field (set once in `DocSession.initialize()`) persists across all view lifecycle events.

**Patterns to follow**

- Use `stories/helpers/SimulatedServer.ts` as the collab backend.
- Keep awareness clearing explicit at hide, evict, and lease transfer boundaries.
- Show the epoch serialization in action: rapid switching story.

**Constraints and boundaries**

- Do not implement per-surface multiplexed awareness. The hard rule is still one live `EditorView` per `DocSession`.
- Storybook should demonstrate the lease transfer rule directly rather than hiding it behind production layout state.

**Verification criteria**

- [ ] Two surfaces can have different active documents at the same time
- [ ] When both surfaces target the same document, the first live view detaches before the second attaches
- [ ] Hidden/evicted views do not leave cursor presence behind (but user presence persists)
- [ ] Remote peers do NOT see leave/rejoin flash during hide/restore/lease transfer
- [ ] Restored views show cursor/selection correctly (yCollab auto-publish)
- [ ] Rapid switching story: A→B→C resolves to C with no intermediate view flicker
- [ ] Mirrored mode story: Converse follows Studio's active doc
- [ ] Old `tab-manager.ts` and `useTabManager.ts` deleted (or documented why kept)
- [ ] `pnpm vitest run` passes
- [ ] `pnpm tsc --noEmit` passes

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/plan/editor/phase-3-view-controller-and-use-document-sessions.md
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/session/view-controller.ts
-f frontend-v2/src/editor/session/useDocumentSessions.ts
-f frontend-v2/src/editor/stories/CollabTabs.stories.tsx
-f frontend-v2/src/editor/TabbedEditor.stories.tsx
-f frontend-v2/src/editor/stories/helpers/SimulatedServer.ts
```
