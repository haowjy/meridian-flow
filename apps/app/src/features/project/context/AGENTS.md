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
- Associated chat-folder roots use catalog presentation labels, never their
  reserved stored basenames. Their menu offers Delete but not Rename or Move;
  contents keep ordinary actions. Placement always retains the stored name.
- Context entries use one interaction boundary and one `ContextOwner` per
  list. It owns action dispatch, operation/refusal state, and move-picker
  wiring; shells own geometry, creation entry points, and navigation.
- Deletion and move persist optimistically through the replica. Pending folder
  deletion hides descendants; refusal restores rows with passive failure
  evidence. File targets retain `documentId`; folder targets retain catalog
  `entryId`.
- Inline create and rename use `useInlineEdit`/`EntryNameField`; do not fork a
  form protocol. Uploads omit generic Delete. Closed move pickers acquire no
  catalogs.
- Tree expansion is tab-local, account/project scoped session state. Resolved
  catalogs prune missing folders; active-document reveal expands once.
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
