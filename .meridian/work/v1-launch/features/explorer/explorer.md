# Explorer

File tree for project document management.

## Scope

- Tree view with folders and documents
- CRUD: create, rename, delete folders and documents
- Drag-and-drop reorder within and across folders
- Word count per document (inline display)
- Context menu (right-click actions)
- Single-click: preview tab. Double-click: persistent tab.

## Hidden Folders

Explorer filters out system folders from the tree display:
- `.agents/` — surfaced through settings UI instead
- `.meridian/` — internal system state (work items, config)

Backend provides two tree API surfaces:
- Explorer API: filtered (writer-facing, hides system folders)
- Internal/settings API: includes system folders with auth

## Carry Forward

- Existing `useTreeStore.ts` — tree state management
- Existing `treeSyncService.ts` — offline-first tree cache with pending ops
- Existing drag-and-drop and reorder logic

## v1 Additions

- Preview-tab pattern for 100+ chapter projects (single-click opens preview, double-click persists)
- Path disambiguation in tab strip for duplicate names (e.g., `Arc 1/notes.md` vs `Arc 2/notes.md`)

## Dependencies

- Design system (tree node components, context menu)
- Tabs (preview vs persistent tab behavior)
