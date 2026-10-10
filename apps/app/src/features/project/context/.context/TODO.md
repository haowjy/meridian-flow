# Context browser TODO

## Optimistic interaction contract

- **CTX-001: Project folder creation into the tree immediately where identity permits.** Project it only if the client can mint the stable tree identity; otherwise keep it server-confirmed rather than projecting a fake row. Keep recursive folder deletion and Work-authority changes server-confirmed.
- **CTX-002: Make by-ID document doors commit the destination before admission.** `open-project-document.ts` awaits both local resource opening and, when absent, server availability before changing the address for links, trail receipts, and search results. Preserve latest-attempt fencing while moving materialization and failure onto the destination.

## Path decision slices

- **Choose a home as one full-path field** (`IdentityPlacementField.tsx`, `use-identity-commit.ts`). Today the field opens empty on the area list with the content-derived name as ghost text. The settled field holds the whole path on one line: it opens with "Knowledge Base /" as real, editable text and the cursor after it, keeps the content-derived name as ghost text that Tab accepts, never selects the area on focus, cannot save without an area, and still creates missing folders. Planned as the next slice ([KB: path decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/interaction/documents/path-navigates-lists-edit.md)).
- **Drag a row onto a folder to move it** in the Files tree and the chat's Scratch section (`ContextTreeRows.tsx`, `../chat/ChatScratch.tsx`). Reuse `EntryMovePicker`'s guards (no file targets, no move into the moved folder's own subtree, collision validation) and the same `setLocation`/`setFolderLocation` admission, so drag and Move… cannot disagree. Planned as its own slice after Move….

## Other

- Uploads in the chat's dock document: the dock shows Scratch notes; a chat-launched Uploads viewer with intake controls is still deferred (#625, #631).
