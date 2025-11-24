---
stack: frontend
status: complete
feature: "Document Editor"
---

# Document Editor

**TipTap rich text editor with auto-save, caching, and markdown conversion.**

## Status:  Complete (Frontend Only)

---

## Features

### TipTap Integration
**Status**:  Complete
- Full TipTap editor with StarterKit extensions
- LRU cache for instant document switching (5 editors cached)
- Markdown ” HTML conversion at boundary
- See [tiptap-integration.md](tiptap-integration.md)

### Rich Text Editing
**Status**:  Complete
- Extensions: StarterKit, Markdown, CharacterCount, Placeholder, Highlight, Typography, Underline
- Toolbar: Bold, italic, underline, strikethrough, headings (H1-H3), lists, blockquote, code block
- Word count display
- See [rich-text-features.md](rich-text-features.md)

### Document Saving
**Status**:  Complete
- Auto-save with 1-second debounce (trailing edge)
- Manual save via Cmd/Ctrl+S
- Save status UI (Saved, Saving, Error with timestamp)
- Backend integration: PATCH to `/api/documents/:id`
- See [saving-and-sync.md](saving-and-sync.md)

### Content Caching
**Status**:  Complete
- Strategy: Reconcile-Newest (cache-first with server reconciliation)
- IndexedDB for instant loads
- Optimistic updates
- Conflict handling via server timestamps
- See [saving-and-sync.md](saving-and-sync.md)

### Markdown Conversion
**Status**:  Complete
- Storage format: Markdown everywhere (backend, API, IndexedDB, stores)
- Load: `editor.commands.setContent(markdown, { contentType: 'markdown' })`
- Save: `editor.getMarkdown()`
- See [markdown-conversion.md](markdown-conversion.md)

---

## Implementation

### Core Files
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/EditorPanel.tsx` - Main editor component
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/editor/extensions.ts` - TipTap extensions config
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/hooks/useEditorCache.ts` - Editor caching hook

### Toolbar
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/EditorToolbar.tsx` - Toolbar component
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/EditorToolbarContainer.tsx` - Toolbar container

### Sync & Cache
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/services/documentSyncService.ts` - Sync logic
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/lib/cache.ts` - Cache strategies
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/lib/db.ts` - IndexedDB schema (Dexie)

---

## User Experience

**Instant document switching**:
1. Editor instances cached (5 most recent)
2. No re-initialization on switch
3. Smooth transitions between documents

**Auto-save flow**:
1. User types content
2. 1-second debounce timer starts
3. On debounce completion: Save to IndexedDB ’ Show "Saving" ’ Sync to server
4. On success: Show "Saved" with timestamp
5. On error: Show error icon, retry automatically

**Conflict resolution**:
- Server timestamps are canonical
- If server has newer content: Overwrite local cache
- Optimistic updates: UI updates immediately, server syncs in background

---

## Performance

**Editor cache benefits**:
- No TipTap re-initialization (expensive operation)
- Instant document switching
- LRU eviction (keeps memory bounded)

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

- See `/_docs/technical/frontend/editor-caching.md` for caching architecture
- See `/_docs/technical/frontend/README.md` for frontend overview
