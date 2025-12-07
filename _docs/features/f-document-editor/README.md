---
stack: frontend
status: complete
feature: "Document Editor"
---

# Document Editor

**CodeMirror 6 markdown editor with live preview, auto-save, and caching.**

## Status: ✅ Complete (Frontend Only)

---

## Features

### CodeMirror Integration
**Status**: ✅ Complete
- CodeMirror 6 with markdown language support
- Live preview rendering within editor
- Markdown-native (no conversion needed)

### Rich Text Editing
**Status**: ✅ Complete
- Toolbar: Bold, italic, headings (H1-H3), lists, blockquote, code block
- Keyboard shortcuts (Cmd/Ctrl+B, Cmd/Ctrl+I, etc.)
- Word count display
- See [rich-text-features.md](rich-text-features.md)

### Document Saving
**Status**: ✅ Complete
- Auto-save with 1-second debounce (trailing edge)
- Manual save via Cmd/Ctrl+S
- Save status UI (Saved, Saving, Error with timestamp)
- Backend integration: PATCH to `/api/documents/:id`
- See [saving-and-sync.md](saving-and-sync.md)

### Content Caching
**Status**: ✅ Complete
- Strategy: Reconcile-Newest (cache-first with server reconciliation)
- IndexedDB for instant loads
- Optimistic updates
- Conflict handling via server timestamps
- See [saving-and-sync.md](saving-and-sync.md)

### Live Preview
**Status**: ✅ Complete
- Inline markdown rendering (headings, bold, italic, etc.)
- Code syntax highlighting
- Links rendered with hover preview

### AI Editing Interface
**Status**: ✅ Available
- `AIEditorRef` interface for AI suggestions
- Decoration support for suggestions, accepted, rejected states
- Programmatic text manipulation via editor commands

---

## Implementation

### Core Files
- `frontend/src/features/documents/components/EditorPanel.tsx` - Main editor component
- `frontend/src/core/editor/codemirror/` - CodeMirror setup and extensions
- `frontend/src/core/editor/api/` - AI integration interface

### Toolbar
- `frontend/src/features/documents/components/EditorToolbar.tsx` - Toolbar component
- `frontend/src/features/documents/components/EditorToolbarContainer.tsx` - Toolbar container

### Sync & Cache
- `frontend/src/core/services/documentSyncService.ts` - Sync logic
- `frontend/src/core/lib/cache.ts` - Cache strategies
- `frontend/src/core/lib/db.ts` - IndexedDB schema (Dexie)

---

## User Experience

**Auto-save flow**:
1. User types content
2. 1-second debounce timer starts
3. On debounce completion: Save to IndexedDB → Show "Saving" → Sync to server
4. On success: Show "Saved" with timestamp
5. On error: Show error icon, retry automatically

**Conflict resolution**:
- Server timestamps are canonical
- If server has newer content: Overwrite local cache
- Optimistic updates: UI updates immediately, server syncs in background

---

## Performance

**IndexedDB benefits**:
- Instant document loads (cached content shows immediately)
- Offline capability (can view cached documents)
- Reduced server requests

---

## Known Gaps

1. **No offline editing** - Can view cached docs, but can't edit without connection
2. **No version history** - No undo beyond current session
3. **No collaborative editing** - Single-user only
4. **No rich media** - Images, tables, embeds not supported yet

---

## Related

- See `/_docs/technical/frontend/README.md` for frontend overview
