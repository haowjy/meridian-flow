# Context browser TODO

## Optimistic interaction contract

## Path decision slices

- **Choose a home as one full-path field** (`IdentityPlacementField.tsx`, `use-identity-commit.ts`). Today the field opens empty on the area list with the content-derived name as ghost text. The settled field holds the whole path on one line: it opens with "Knowledge /" as real, editable text and the cursor after it, keeps the content-derived name as ghost text that Tab accepts, never selects the area on focus, cannot save without an area, and still creates missing folders. Missing folders travel as the destination's `createFolders` beneath the deepest existing folder, as linked creation sends them (`../../links/use-create-linked-document.ts`); never fall back to a path destination. Planned as the next slice ([KB: path decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/file-tree.md)).
- **Drag from the desktop** (work item `drag-anywhere` in the docs repo). Rows, tabs, crumbs, Recent rows and mention chips already drag (`entry-drag/`, `tree-drop/`, [drag sources](qa/drag-sources.md)); a drop into the composer or editor makes a mention, and a drop across systems asks Move or Copy. Still to build: OS files dropped into a chat's Uploads. The dispatcher carries only the rows route today; import (#798) brings back its desktop-files route, gives import targets `treeRootId`, and keeps `WindowDropGuard`. Decide then whether desktop-file drops use the row edges as well; edges respond only to in-app row drags today.

## Other

- Uploads from a chat: uploads open read-only in `UploadViewerDialog`; a chat-launched Uploads viewer with intake controls is still deferred (#625, #631).

- Router scroll restoration (`scrollRestoration: true` in `src/router.tsx`) tracks every element that scrolls by its DOM path and writes its old offset back after each navigation, shell scrollers included (file tree, sidebar). Main's tab strip re-reveals its active tab after each render (`useActiveTabVisibility` in `shell/MainTabStrip.tsx`); the other shell scrollers are not checked. If one misbehaves, decide whether shell chrome should be outside restoration altogether rather than fixing each.
- `document-identity-bar.md` still describes path crumbs (`DocumentPath.tsx`) that the identity row no longer renders; rewrite its first sections to what the bar shows now (state chips, the review line).
- A burst of separate tree-list updates redraws every tree once per update: a model's 60 `write move` calls in one turn make 60 publishes from `core/tree-list/tree-list-session.ts`, each re-rendering the sidebar, the Changes panel and the open tab. The card's Undo now sends one update per list (`drizzle-turn-tree-inverse.ts`), which took a 60-rename Undo from about 15 s of blocked tab to 0.5 s; coalescing publishes to one per frame would cover the model's bursts too, but changes when every tree reader sees a change.
- The sidebar's "Chapter 01 deleted. Undo" notice stays up after the document is restored from Trash; it should go when what it offers to undo no longer stands.
- A tree delete's Undo notice ("X deleted. Undo") stays in the Chats sidebar footer after the
  writer leaves Manuscript for another source. It belongs to the Manuscript tree; show it there,
  or dismiss it when the source changes (`project/shell/sidebar/use-sidebar-undo.ts`).
