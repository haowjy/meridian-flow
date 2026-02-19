---
stack: frontend
status: complete
feature: "Document Editor"
---

# Document Editor

**CodeMirror 6 editor with live preview, Yjs realtime sync, and offline persistence.**

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
- Collab-enabled text docs (`.md`, `.markdown`, `.txt`) sync over project-scoped Yjs transport: `/ws/projects/{projectId}` + per-document `doc:subscribe`/`doc:unsubscribe`
- Workspace-level transport is managed by `useProjectCollab` + `ProjectCollabProvider`
- Legacy PATCH save path remains for non-collab editors
- Non-collab network/5xx save failures persist to Dexie `pendingDocumentSaves` and are drained on startup/`online`/periodic tick
- Save status UI remains in header
- Stale save-ack race fixed (prevents false conflict + autosave stall): see `/_docs/future/bugs/document-sync-stale-save-ack-race.md`
- See [saving-and-sync.md](saving-and-sync.md)

### Content Caching
**Status**: ✅ Complete
- Strategy: Reconcile-Newest for metadata/load path
- `y-indexeddb` for offline Yjs document state (text docs)
- Optimistic updates
- Conflict handling via server timestamps
- See [saving-and-sync.md](saving-and-sync.md)

### Live Preview
**Status**: ✅ Complete
- Inline markdown rendering (headings, bold, italic, etc.)
- Code syntax highlighting
- Links rendered with hover preview
- Resolved internal markdown links (`[text](path.md)`) render as the same inline pill style used by resolved wiki-links

### Wiki-Link References
**Status**: ✅ Complete
- `@[[path | name]]` wiki-links render as inline pills when cursor is away
- Resolved wiki-links and resolved internal markdown links share the same pill rendering behavior
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
3. On debounce completion: Save to IndexedDB -> Show "Saving" -> Sync to server
4. On success: Show "Saved" with timestamp
5. On network/5xx error (non-collab): keep optimistic state, persist to `pendingDocumentSaves`, retry in background drain
6. On 4xx error: surface error for manual retry (not auto-queued)

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

1. **No proposal-review UX in collab flow yet** - Phase 3 scope
2. **No persisted history/snapshot UI yet** - Phase 2 scope
3. **No rich media** - Images, tables, embeds not supported yet

---

## Related

- [../fb-ai-editing/](../fb-ai-editing/) - AI inline suggestions feature
- `/_docs/technical/frontend/README.md` - Frontend overview
- `/_docs/technical/frontend/inline-editing/` - Inline editing architecture
