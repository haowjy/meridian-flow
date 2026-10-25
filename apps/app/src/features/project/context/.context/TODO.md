# Context browser TODO

## Optimistic interaction contract

- **CTX-001: Project folder creation into the tree immediately where identity permits.** Project it only if the client can mint the stable tree identity; otherwise keep it server-confirmed rather than projecting a fake row. Folder deletion already uses optimistic namespace intent; Work-authority changes remain server-confirmed.

## Path decision slices

- **Choose a home as one full-path field** (`IdentityPlacementField.tsx`, `use-identity-commit.ts`). Today the field opens empty on the area list with the content-derived name as ghost text. The settled field holds the whole path on one line: it opens with "Knowledge Base /" as real, editable text and the cursor after it, keeps the content-derived name as ghost text that Tab accepts, never selects the area on focus, cannot save without an area, and still creates missing folders. Missing folders travel as the destination's `createFolders` beneath the deepest existing folder, as linked creation sends them (`../../links/use-create-linked-document.ts`); never fall back to a path destination. Planned as the next slice ([KB: path decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/interaction/documents/path-navigates-lists-edit.md)).
- **Drag beyond list rows** (work item `drag-anywhere` in the docs repo). Rows already select and drag within one system through `entry-drag/` and `tree-drop/`. Still to build: reorder within a folder (fractional order keys; the insertion line between rows stays reserved for it, and a drop on the row's own folder stays quiet until then); drops into the composer and the editor as mention chips, folder mentions and the folder chip's drill-in menu, and OS files into a chat's Uploads; crossing systems through an explicit Move or Copy choice with a server Copy endpoint; tabs, crumbs, Recent rows and mention chips as sources (they always ask first). Every new drop path places through `moveRows` (`entry-drag/execute-move.ts`), so drag and Move… cannot disagree. The dispatcher carries only the rows route today; import (#798) brings back its desktop-files route (with `lib/dropped-items.ts`, removed as dormant), gives import targets `catalogRootId`, and keeps `WindowDropGuard`.

## Other

- Uploads in the chat's dock document: the dock shows Scratch notes; a chat-launched Uploads viewer with intake controls is still deferred (#625, #631).

- Review the inherited session-authority exception that terminalizes adopted local-origin lineage from availability; it is explicitly out of scope for PR #754.
