# Phase 3: ViewController + useDocumentSessions

## Goal

Replace the current tab-owned lifecycle with per-surface controllers that borrow shared `DocSession`s from the pool, enforce the one-live-view-per-doc rule, and let Studio and Converse keep independent active documents.

## Dependencies

- Phase 2 complete

## Parallelism

- `P3.1` must land first.
- `P3.2` depends on `P3.1`.
- `P3.3` depends on `P3.1` and partially on `P3.2`; it should run after the hook contract is stable.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P3.1 | New `ViewController` replaces `TabManager` as the surface lifecycle owner | High | `gpt-5.4` |
| P3.2 | `useDocumentSessions()` wraps one controller and a shared pool | Medium | `gpt-5.3-codex` |
| P3.3 | Stories and awareness lifecycle prove lease transfer, hide/evict restore, and no ghost cursors | High | `gpt-5.4` |

### Step P3.1: Build `ViewController`

**Scope and intent**

Salvage the useful DOM-host and LRU ideas from `tabs/tab-manager.ts`, but move them into a per-surface controller that never owns Yjs lifecycle. Hidden views remain mounted for fast switches; evicted views destroy only the `EditorView` and keep the underlying `DocSession` warm in the pool.

**Files to create or modify**

- `frontend-v2/src/editor/session/view-controller.ts`
- `frontend-v2/src/editor/tabs/tab-manager.ts` - either delete or convert into a temporary compatibility shim that delegates to `ViewController`
- `frontend-v2/src/editor/tabs/useTabManager.ts` - delete or replace after downstream migration

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

export interface ViewControllerOptions {
  surfaceId: string
  sessionPool: SessionPool
  maxLive?: number
  createEditorView(args: {
    session: DocSession
    container: HTMLDivElement
    restore?: ViewRestoreState | null
  }): EditorView
}

export class ViewController {
  setHost(el: HTMLDivElement | null): void
  open(doc: { id: string; name: string }): Promise<EditorView | null>
  switchTo(id: string): Promise<EditorView | null>
  close(id: string): Promise<void>
  getActiveView(): EditorView | null
  getOpenDocuments(): Array<{ id: string; name: string; isModified: boolean }>
  subscribe(listener: () => void): () => void
  destroy(): Promise<void>
}
```

**Patterns to follow**

- Reuse the current CSS show/hide and `requestMeasure()` behavior from `tab-manager.ts`.
- Restore from current `session.ytext`, not cached `EditorState`.

**Constraints and boundaries**

- A `ViewController` may keep only view-local restore hints: scroll and optional `Y.RelativePosition`.
- Do not let it create/destroy `DocSession`s directly. All document ownership flows through `SessionPool`.

**Verification criteria**

- LRU view eviction destroys only `EditorView` resources.
- Restoring an evicted doc rebuilds from the latest `Y.Text`.
- Closing the last visible view releases the session back to the pool instead of destroying Yjs resources immediately.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/tabs/tab-manager.ts
-f frontend-v2/src/editor/tabs/useTabManager.ts
-f frontend-v2/src/editor/session/session-pool.ts
-f frontend-v2/src/editor/Editor.tsx
```

### Step P3.2: Add `useDocumentSessions()` And Shared Pool Wiring

**Scope and intent**

Provide the React API that Studio and Converse will consume. The hook owns one controller instance, exposes the current open-doc snapshot, and reaches into a shared `SessionPool` supplied above the surface.

**Files to create or modify**

- `frontend-v2/src/editor/session/useDocumentSessions.ts`
- `frontend-v2/src/editor/session/session-pool-context.tsx`
- `frontend-v2/src/editor/TabbedEditorShell.tsx` if prop naming or snapshot shapes need alignment

**Interface contracts**

```ts
export interface UseDocumentSessionsResult {
  hostRef: React.RefCallback<HTMLDivElement>
  activeDocId: string | null
  openDocs: Array<{ id: string; name: string; isModified: boolean }>
  open(doc: { id: string; name: string }): void
  switchTo(id: string): void
  close(id: string): void
  getSession(id: string): DocSession | null
  getActiveView(): EditorView | null
}
```

**Patterns to follow**

- Reuse `useSyncExternalStore` from the current `useTabManager.ts`.
- Keep the hook thin. Controller and pool stay headless/testable.

**Constraints and boundaries**

- Do not embed layout-specific assumptions in the hook.
- Keep the shared pool in context or another top-level singleton-style wrapper. Do not recreate it per hook call.

**Verification criteria**

- Two hook instances can point at the same pool without duplicating sessions.
- Snapshot updates are tear-free.
- Unmounting a surface destroys only its controller, not the shared pool unless the provider itself unmounts.

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/session/view-controller.ts
-f frontend-v2/src/editor/session/session-pool.ts
-f frontend-v2/src/editor/tabs/useTabManager.ts
-f frontend-v2/src/editor/TabbedEditorShell.tsx
```

### Step P3.3: Migrate Stories And Implement Awareness Lifecycle Rules

**Scope and intent**

Prove the new lifecycle with Storybook. This is the step that should catch lease transfer mistakes, stale restore bugs, and ghost cursors before transport/proposal work piles on.

**Files to create or modify**

- `frontend-v2/src/editor/collab/awareness-lifecycle.ts`
- `frontend-v2/src/editor/stories/CollabTabs.stories.tsx`
- `frontend-v2/src/editor/TabbedEditor.stories.tsx`
- `frontend-v2/src/editor/stories/helpers/CollabEditor.tsx` if shared helpers are useful

**Interface contracts**

```ts
export function clearLocalAwareness(awareness: Awareness): void
export function publishViewAwareness(
  awareness: Awareness,
  view: EditorView,
): void
```

**Patterns to follow**

- Use `stories/helpers/SimulatedServer.ts` as the collab backend.
- Keep awareness clearing/publishing explicit at hide, evict, lease transfer, and restore boundaries.

**Constraints and boundaries**

- Do not implement per-surface multiplexed awareness. The hard rule is still one live `EditorView` per `DocSession`.
- Storybook should demonstrate the lease transfer rule directly rather than hiding it behind production layout state.

**Verification criteria**

- Two surfaces can have different active documents at the same time.
- When both surfaces target the same document, the first live view detaches before the second attaches.
- Hidden/evicted views do not leave local cursor presence behind.
- Restored views republish cursor/selection awareness correctly.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/session/view-controller.ts
-f frontend-v2/src/editor/session/useDocumentSessions.ts
-f frontend-v2/src/editor/stories/CollabTabs.stories.tsx
-f frontend-v2/src/editor/TabbedEditor.stories.tsx
-f frontend-v2/src/editor/stories/helpers/SimulatedServer.ts
```
