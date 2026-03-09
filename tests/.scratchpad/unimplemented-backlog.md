# Unimplemented Backlog

Items extracted from deleted plan files that were never implemented. Originally from `_docs/plans/collab-ai/collab-bugfixes.md`.

## Frontend: Editor Read-Only Until Connected

**Problem:** Editor briefly becomes editable during "connecting" state for collab docs. Users can type into "Start writing..." before sync is established — potential data loss.

**Root Cause:** `useDocumentContent.ts` — `isEditable` doesn't check collab connection state:
```ts
const isEditable = isInitialized && activeDocument?.id === documentId && !isLoading;
```

**Fix:** `isEditable` must also require `collabConnectionState === "connected"` for collab-enabled documents. Non-collab docs unaffected.

**Key Files:**
- `frontend/src/features/documents/hooks/useDocumentContent.ts`
- `frontend/src/features/documents/components/EditorPanel.tsx`
- `frontend/src/features/documents/stores/useCollabStore.ts`

---

## Frontend: Auto-Accept Toggle in Project Settings

**Problem:** Backend has full auto-accept policy infrastructure (project + user cascade in `auto_accept_store.go`, `proposal_service.go`, migration `00021`), but no UI toggle exists.

**Fix:** Add toggle to `ProjectSettingsPanel.tsx`, wire to existing backend API.

**Key Files:**
- `frontend/src/features/projects/components/ProjectSettingsPanel.tsx`
- `backend/internal/repository/postgres/collab/auto_accept_store.go`

---

## Frontend: Unified Connection Status Indicator

**Problem:** Two separate status displays — `SaveStatusIcon` (cloud icons) in header and `CollabConnectionIndicator` as separate row below header.

**Fix:** Merge into single header indicator. Collab docs show connection state icon with tooltip, non-collab docs keep existing save status. Remove separate `CollabConnectionIndicator` row.

**Key Files:**
- `frontend/src/features/documents/components/SaveStatusIcon.tsx`
- `frontend/src/features/documents/components/CollabConnectionIndicator.tsx`
- `frontend/src/features/documents/components/DocumentStatus.tsx`
- `frontend/src/features/documents/components/EditorHeader.tsx`

---

## Frontend: Snapshot Preview Without Restore

**Problem:** Version history requires restoring a snapshot to see its content. No preview capability.

**Backend status:** `GET /api/documents/{id}/snapshots/{snapshotId}/content` endpoint already exists (`collab_snapshot.go:GetSnapshotContent`). Backend work is done.

**Remaining frontend work:**
- Click snapshot in list -> fetch content -> show diff preview
- Use `@codemirror/merge` for side-by-side diff (infrastructure already exists for AI proposal review)
- "Restore" button only in preview mode, "Close" to dismiss

**Key Files:**
- `frontend/src/features/documents/components/VersionHistoryPanel.tsx`
- `frontend/src/core/lib/api.ts`

---

## Plan Audit Results (gpt-5.4, 2026-03-09)

Two sibling plans were confirmed fully executed and archived:
- `fix-duplicate-content-bootstrap.md` — all tasks CONFIRMED in codebase
- `harden-collab-edge-cases.md` — all 7 tasks CONFIRMED in codebase

New gaps found during audit (tracked in `bugs-found.md` #6-8):
- Snapshot restore clears `ai_content` (same bug class as offline apply clobber, already fixed elsewhere)
- Pre-restore safety snapshot captures empty state for REST-only docs
- No CreateSnapshot handler tests (bootstrap logic has no unit coverage)
