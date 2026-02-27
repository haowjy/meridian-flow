---
detail: standard
audience: developer
---

# Collab Bugfixes Plan

## Overview

A set of independent fixes and improvements discovered during collab testing after Phase 4.7. Four tasks, each independently shippable.

## Task 1: Editor Read-Only Until Connected

**Problem:** When a collab-enabled document isn't in IndexedDB and needs downloading, the editor briefly becomes editable during the "connecting" state. Users can type into "Start writing..." before the collab sync is established, leading to potential data loss or conflicts.

**Root Cause:** `useDocumentContent.ts:176-177` — `isEditable` doesn't check collab connection state:
```ts
const isEditable = isInitialized && activeDocument?.id === documentId && !isLoading;
```

**Fix:**
- For collab-enabled documents, `isEditable` must also require `collabConnectionState === "connected"`
- The "Start writing..." placeholder should not appear until the document is ready for editing
- Consider showing a loading/syncing state in the editor area while connecting

**Key Files:**
- `frontend/src/features/documents/hooks/useDocumentContent.ts` — isEditable logic
- `frontend/src/features/documents/components/EditorPanel.tsx` — isContentLoading gate, placeholder
- `frontend/src/features/documents/stores/useCollabStore.ts` — connection state

**Acceptance Criteria:**
- [ ] Editor is NOT editable until collab connection state is "connected" (for collab docs)
- [ ] Non-collab documents (.json, etc.) are unaffected
- [ ] Loading/syncing indicator shows while connecting
- [ ] No "Start writing..." visible during connecting state
- [ ] Editor becomes editable promptly once connected

---

## Task 2: Auto-Accept Toggle in Project Settings

**Problem:** Backend has full auto-accept policy infrastructure (project-level + user-level cascade), but there's no UI toggle. Users cannot turn off auto-apply for AI proposals.

**Backend State:** Already implemented:
- `auto_accept_store.go` — loads project-level and user-level preferences
- `proposal_service.go` — resolution cascade: Agent override → Project policy → User policy → Service default
- DB migration `00021` added `auto_accept_proposals` column to projects table

**Fix:**
- Add auto-accept toggle to `ProjectSettingsPanel.tsx`
- Wire to existing backend API for project preferences
- Show current state (on/off) with clear description of what it does

**Key Files:**
- `frontend/src/features/projects/components/ProjectSettingsPanel.tsx` — add toggle here
- `frontend/src/features/projects/types/project.ts` — may need to add autoAccept to ProjectPreferences
- `backend/internal/handler/` — check if project update endpoint supports auto_accept field
- `backend/internal/repository/postgres/collab/auto_accept_store.go` — reference for backend model

**Acceptance Criteria:**
- [ ] Toggle visible in Project Settings panel
- [ ] Toggle reads current project auto-accept state from backend
- [ ] Toggle updates project auto-accept state via API
- [ ] Clear label and description explaining what auto-accept does
- [ ] Default is ON (matching current behavior)

---

## Task 3: Unified Connection Status Indicator in Header

**Problem:** Two separate status displays — SaveStatusIcon (cloud icons) in the header and CollabConnectionIndicator as a separate row below the header. User wants a single, compact indicator in the header with tooltip for details.

**Current State:**
- `SaveStatusIcon.tsx` — Cloud/CloudOff/Loader2/AlertCircle icons for save state
- `CollabConnectionIndicator.tsx` — Colored dot + text label (Connected/Syncing/Disconnected) as separate row
- `DocumentStatus.tsx` — Word count + SaveStatusIcon in header trailing content
- `EditorHeader.tsx` — Header layout with PanelHeader

**Fix:**
- Merge connection status into the header where the cloud icon currently lives
- For collab docs: show connection state icon (colored dot or appropriate icon) instead of cloud
- For non-collab docs: keep existing save status icon
- Remove text labels, move to tooltip (SimpleTooltip already available)
- Remove the separate CollabConnectionIndicator row below the header

**Key Files:**
- `frontend/src/features/documents/components/SaveStatusIcon.tsx`
- `frontend/src/features/documents/components/CollabConnectionIndicator.tsx`
- `frontend/src/features/documents/components/DocumentStatus.tsx`
- `frontend/src/features/documents/components/EditorHeader.tsx`
- `frontend/src/features/documents/components/EditorPanel.tsx`

**Acceptance Criteria:**
- [ ] Single status indicator in header (no separate row)
- [ ] Collab docs show connection state (connected/syncing/disconnected) as icon with tooltip
- [ ] Non-collab docs show save state as before
- [ ] Text labels removed from inline display, available on hover/tooltip
- [ ] Clean, minimal visual footprint

---

## Task 4: Snapshot Preview Without Restore

**Problem:** Version history requires applying a snapshot to see its content, then reverting. No preview capability. Users want Google Docs-style preview.

**Current State:**
- `VersionHistoryPanel.tsx` — lists snapshots with "Restore" button, no preview
- Backend `collab_snapshot.go` — has create/list/restore/delete but NO content retrieval endpoint
- `@codemirror/merge` already used for AI proposal review — infrastructure exists for diff views
- Snapshot stored as binary Yjs state in `collab_document_snapshots.yjs_state`

**Fix — Backend:**
- Add `GET /api/documents/{id}/snapshots/{snapshotId}/content` endpoint
- Returns the snapshot's text content (decode Yjs state → extract text)
- Keep it lightweight — just the plain text content

**Fix — Frontend:**
- Click a snapshot in the list → fetch its content → show diff preview
- Use @codemirror/merge to show current doc vs snapshot side-by-side (or unified diff)
- "Restore" button only in preview mode to confirm intent
- "Close preview" to dismiss without changes

**Key Files:**
- `backend/internal/handler/collab_snapshot.go` — add content endpoint
- `backend/internal/repository/postgres/collab/document_store.go` — GetSnapshot already loads Yjs state
- `frontend/src/features/documents/components/VersionHistoryPanel.tsx` — add preview UI
- `frontend/src/core/lib/api.ts` — add snapshot content API call
- `packages/cm6-collab/src/review/merge.ts` — reference for @codemirror/merge usage

**Acceptance Criteria:**
- [ ] New backend endpoint returns snapshot text content
- [ ] Clicking a snapshot in the list shows a preview (diff view)
- [ ] Preview shows current content vs snapshot content
- [ ] "Restore" available from preview to confirm
- [ ] "Close" dismisses preview without changes
- [ ] No full page reload needed for preview

---

## Task Order

These are independent — any order works. Suggested order by complexity/risk:
1. Task 1 (editor read-only) — smallest, highest user-impact bug
2. Task 3 (status indicator) — UI-only, straightforward
3. Task 2 (auto-accept toggle) — frontend + possible API work
4. Task 4 (snapshot preview) — most complex, full-stack
