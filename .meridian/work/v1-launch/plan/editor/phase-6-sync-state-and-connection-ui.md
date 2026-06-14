# Phase 6: Sync State + Connection UI

## Goal

Expose accurate per-document connectivity state to the editor chrome without implying durable persistence guarantees the backend does not provide.

## Dependencies

- Phase 3 complete
- Phase 4 complete

## Parallelism

- `P6.1` must land before `P6.2`.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P6.1 | Session-level sync-state runtime and selectors | Medium | `gpt-5.3-codex` |
| P6.2 | Title-header UI and story coverage for connected/offline/local-changes-pending/degraded-local-save | Medium | `gpt-5.3-codex` |

### Step P6.1: Add Per-doc Sync-state Tracking

**Scope and intent**

Derive the coarse user-facing sync state from Yjs update events plus provider connection events. This is where "offline but local edits pending" becomes a first-class status instead of an ad hoc UI guess.

**Files to create or modify**

- `frontend-v2/src/editor/session/doc-session.ts`
- `frontend-v2/src/editor/session/session-selectors.ts`
- `frontend-v2/src/editor/session/doc-session.test.ts`

**Interface contracts**

```ts
export type DocSyncState = "connected" | "local-changes-pending" | "disconnected"

export interface DocSessionStatus {
  connectionState: ConnectionState
  syncState: DocSyncState
  degradedPersistence: boolean
  frozenReason: FrozenReason | null
}
```

**Patterns to follow**

- Treat "connected" as transport truth only.
- Treat provider disconnection plus unsent local edits as `local-changes-pending`.

**Constraints and boundaries**

- No `"saved"`, `"synced"`, or `"syncing"` labels.
- Do not infer durable server persistence from Yjs handshake completion.

**Verification criteria**

- Session tests cover: start disconnected, edit while offline, reconnect, disconnect before editing, degrade local persistence.
- Status selectors are reusable by Storybook and real UI code.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/session/doc-session.ts
-f frontend-v2/src/editor/collab/document-ws-provider.ts
```

### Step P6.2: Update Connection UI And Stories

**Scope and intent**

Update the title-header connection indicator and shell wiring so the UI reflects the real status contract from `P6.1`.

**Files to create or modify**

- `frontend-v2/src/editor/title-header/ConnectionStatus.tsx`
- `frontend-v2/src/editor/title-header/TitleHeader.tsx`
- `frontend-v2/src/editor/TabbedEditorShell.tsx`
- `frontend-v2/src/editor/stories/ConnectionStatus.stories.tsx`
- `frontend-v2/src/editor/TabbedEditor.stories.tsx` if it should surface the new label set

**Interface contracts**

```ts
export interface ConnectionIndicatorState {
  connectionState: ConnectionState
  syncState: DocSyncState
  degradedPersistence?: boolean
}
```

Expected labels:
- `Connected`
- `Offline`
- `Offline - changes saved locally`
- local-persistence warning copy when `degradedPersistence === true`

**Patterns to follow**

- Keep the current title-header visual language.
- Separate iconography for transport state from the degraded-local-save warning.

**Constraints and boundaries**

- Do not reuse the old `lastSaved` copy as a pseudo-sync indicator.
- Avoid adding animation-heavy states that imply upload progress the backend does not expose.

**Verification criteria**

- Storybook covers all indicator states and warning combinations.
- Title header renders the right label when the session is offline before edits versus offline after local edits.
- No code path shows "Saved", "Synced", or "Syncing".

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/session/session-selectors.ts
-f frontend-v2/src/editor/title-header/ConnectionStatus.tsx
-f frontend-v2/src/editor/title-header/TitleHeader.tsx
-f frontend-v2/src/editor/TabbedEditorShell.tsx
```
