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
- Stale save-ack race fixed (prevents false conflict + autosave stall): see `/_docs/future/bugs/document-sync-stale-save-ack-race.md`
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

### Wiki-Link References
**Status**: ✅ Complete
- `@[[path | name]]` wiki-links render as inline pills when cursor is away
- Copy/cut/paste uses shared CM clipboard extension + codec registry
- Meridian clipboard payload uses v2 `elements[]` (v1 `references[]` still accepted on paste)
- Paste accepts Meridian payload and inserts canonical wiki-link markdown
- Wiki-link syntax is single-line only (newline inside `[[...]]` is not parsed as a link)
- Enables cross-surface reference copy/paste with thread composer
- Filename-only wiki-link resolution now only applies when the filename is unique
  - Ambiguous filename matches stay plaintext `@[[...]]` (prevents wrong-doc binding)

### AI Editing Interface
**Status**: ✅ Complete
- Inline diff view with accept/reject buttons
- PUA markers for embedded diffs
- Full undo/redo support (Cmd+Z)
- See [../fb-ai-editing/](../fb-ai-editing/) for details

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

- [../fb-ai-editing/](../fb-ai-editing/) - AI inline suggestions feature
- `/_docs/technical/frontend/README.md` - Frontend overview
- `/_docs/technical/frontend/inline-editing/` - Inline editing architecture
