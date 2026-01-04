---
stack: both
status: complete
feature: "AI Editing"
---

# AI Editing

**Inline AI suggestions with accept/reject UI and unified undo/redo.**

## Status: ✅ Complete (Full Stack)

- **Backend**: ✅ `ai_version` storage, CAS concurrency, tri-state PATCH
- **Frontend**: ✅ Diff view, decorations, hunk navigation, conflict handling

---

## Features

### Merged Document Display
**Status**: ✅ Complete
- AI suggestions shown inline with original text
- PUA (Private Use Area) Unicode markers for diff regions
- Strikethrough for deletions, underline for insertions
- See [architecture.md](architecture.md)

### Accept/Reject Operations
**Status**: ✅ Complete
- Per-hunk accept/reject buttons on hover
- Accept All / Reject All in navigator pill
- Full undo/redo support (Cmd+Z works)
- Operations are CM6 transactions

### Edit Protection
**Status**: ✅ Complete
- Deletion regions read-only (original text preserved)
- Insertion regions editable (can refine AI text)
- Outside hunks editable (updates both versions)
- Blocked edit feedback via toast

### Conflict Handling
**Status**: ✅ Complete
- CAS token (`ai_version_rev`) prevents stomping unseen updates
- 409 Conflict triggers refresh prompt
- Background AI updates detected via polling
- See [backend-api.md](backend-api.md)

### Clipboard Safety
**Status**: ✅ Complete
- Copy/cut strips PUA markers (outputs markdown)
- Paste strips markers (prevents corruption)
- See `frontend/src/core/editor/codemirror/diffView/clipboard.ts`

---

## Implementation

### Backend
- `backend/internal/domain/models/docsystem/document.go` - AIVersion, AIVersionRev fields
- `backend/internal/handler/document.go` - PATCH with tri-state, CAS validation

### Frontend Core
- `frontend/src/core/lib/mergedDocument.ts` - Build/parse merged documents
- `frontend/src/core/editor/codemirror/diffView/` - CM6 extension bundle
- `frontend/src/core/services/saveMergedDocument.ts` - Save orchestration

### Frontend Hooks
- `frontend/src/features/documents/hooks/useDocumentContent.ts` - Hydration, state
- `frontend/src/features/documents/hooks/useDocumentSync.ts` - Debounced save, CAS
- `frontend/src/features/documents/hooks/useDiffView.ts` - Extension management

### UI Components
- `frontend/src/features/documents/components/AIHunkNavigator.tsx` - Navigator pill
- `frontend/src/core/editor/codemirror/diffView/HunkActionWidget.ts` - Inline buttons

---

## User Experience

**Review flow**:
1. AI edits document via `doc_edit` tool
2. Editor displays merged view with inline diffs
3. User reviews each hunk (hover shows ✓/✕ buttons)
4. Accept/reject operations update document
5. Cmd+Z undoes any accept/reject

**Conflict flow**:
1. AI updates document while user is reviewing
2. Polling detects `ai_version_rev` change
3. "AI Updated" prompt appears
4. User clicks Refresh to see new changes

---

## Known Gaps

1. **No SSE for instant updates** - Uses polling (2s interval) instead of SSE
2. **No partial accept** - Can't accept part of an insertion
3. **No diff preview before AI edit** - AI applies changes directly

---

## Related

- [architecture.md](architecture.md) - Merged document pattern
- [backend-api.md](backend-api.md) - PATCH semantics, CAS token
- [frontend-diff-view.md](frontend-diff-view.md) - CodeMirror extension
- `/_docs/technical/frontend/inline-editing/` - Deep-dive architecture
- `/_docs/features/f-document-editor/` - Base editor features
