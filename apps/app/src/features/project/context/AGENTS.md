# features/project/context — context file tree

This directory is the browse surface over the account resource replica. It
projects project documents, Scratch, and Work Files into the desktop tree,
phone browser, recent-document chooser, and document hosts. Uploads remain
chat resources rather than ordinary Editor tabs.

## Rules

- The replica owns durable descriptors, catalog checkpoints, local content,
  placement, and namespace journal state. React Query acquires and projects;
  it is not a second catalog owner.
- Every placement consumer uses the shared `ResourcePlacement` snapshot,
  including other Works. Recovery keeps real journal identities reachable;
  synthetic ancestors are navigation-only and have no mutations.
- Context entries use one interaction boundary. It owns action dispatch and
  operation/refusal state; shells own geometry, creation entry points,
  navigation, and the notice surface where Move… reports.
- Deletion and move persist optimistically through the replica. Pending folder
  deletion hides descendants; refusal restores rows with passive failure
  evidence. File targets retain `documentId`; folder targets retain catalog
  `entryId`.
- A row changes folders only through `moveRows` (`entry-drag/execute-move.ts`):
  Move…, a drop and a drop's Undo resolve one `ParentRef` by folder ID (or an
  area root with its authority) before the move is ready, share one
  identity-based refusal (`moveRefusal` in `move-plan.ts`: inside itself;
  already there is a quiet no-op), and arrive at the next free name that
  `execute-move.ts` predicts. The hover hint and Move… warn with that same
  prediction before a row arrives renamed. Order goes the same way: a row-edge
  drop and Move…'s "Change position" send a sibling position (before/after a
  sibling, start, end), never a rank. Don't place entries anywhere else.
- Selection and dragging (`entry-drag/`): one desktop list is one selection,
  one drop route and one drop scope (`useEntryList`/`EntryList`). They carry
  identities, never placement or grants; plans read placement from the replica at hover,
  drop and Undo. A list row dropped within one system moves at once; one across systems, and
  every other source naming a document or folder (chips, tabs, crumbs, Recent rows, receipts,
  Uploads entries, selected links) asks first, at the pointer (`entry-drag/drop-choice.ts`).
  Those sources use `useReferenceDrag` and nothing else; what a drag may do (Move is refused out
  of an archived or unlisted Work's Scratch) is judged in `resolveDrop`. Contract in
  `.context/tree-interactions.md`. A writing surface may copy
  those identities into references through its own drop extension; that drop
  never enters the tree's move route. Desktop only; phones publish Move… directly
  to their notice surface, and every move drop also has that menu path.
- Drop dispatch (`tree-drop/`) is the one scope that row moves and desktop
  import (#798) share; add a route, not a second scope. A refused drop is not
  an error: no fill, no red, the pointer hint names the reason.
- Inline create and rename use `useInlineEdit`/`EntryNameField`; do not fork a
  form protocol. Uploads omit generic Delete. Closed move pickers acquire no
  catalogs.
- Tree expansion is tab-local, account/project scoped session state. Resolved
  catalogs prune missing folders; active-document reveal expands once.
- A section's pane states are distinct: rows, an error row with Retry when the
  catalog query failed, "Loading files…" while the catalog is not installed yet
  (`isComplete` false), and "No context files yet." only once it is. A failed or
  in-flight load must never read as an empty project.
- Document opening records the active tab, not the intent. The device record
  updates before the server request, which waits for `whenOnServer`; restored
  parked tabs do not count as opens.
- The empty Editor pane is a chooser. Selecting a recent document navigates
  without seeding a tab; route and removal owners handle continuity and close.

## Child guide

- [`file-suggestions/AGENTS.md`](file-suggestions/AGENTS.md)

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for catalog ownership,
editor admission, identity continuity, and links to the deeper contracts.
See [`.context/document-identity-bar.md`](.context/document-identity-bar.md),
[`.context/resource-catalog-and-editor-lifecycle.md`](.context/resource-catalog-and-editor-lifecycle.md),
[`.context/tree-interactions.md`](.context/tree-interactions.md),
[`.context/TODO.md`](.context/TODO.md), and
[`.context/FUTURE.md`](.context/FUTURE.md) for on-demand detail.
