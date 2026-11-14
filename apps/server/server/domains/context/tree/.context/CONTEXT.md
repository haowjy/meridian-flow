# context/tree

What the project tree's readers and its retention job read and decide. The writer of the rows
is the list store; this directory reads them.

## Where the tree lives

The project tree is a list of records in one Yjs document per project (per account for
`user://`), stored in the document journal under the list's id. Its rows are derived from the
list in the admitting transaction and written by nothing else:

- `tree_nodes`: one row per node of the live replay (folder or document), with its name,
  place, rank, location version and, for a node in Trash, the `delete` record that took it
  (`trash_record`) and when the server admitted it (`trashed_at`). A purged node has no row.
- `branch_tree_nodes`: what a Work's view shows differently from live (a node that differs, a
  live node the Work lacks, a node only the Work has).
- `documents`: a document's content facts (storage, size, metadata, `content_purged_at`) and
  its owner project. Its name, place and type are `tree_nodes`'.

`tree-relations.ts` turns them into the two relations every reader composes. A Work's view is
`tree_nodes` rows it has no row for, then its own rows; walk a path in it one level at a time
(the measurements are in the store page).

## A node in no view

A document is in no view when it has no `tree_nodes` row (it was purged or never reached live)
and no `branch_tree_nodes` row. Two kinds:

- **In Trash**: a `tree_nodes` row with `trash_record`. Restorable; its text is still in the
  journal. Not in any view, so nothing but the server reads it.
- **A drafted create that was discarded** (or refused and not kept): a `documents` row with no
  node row anywhere. `documents.in_no_view_since` is the time the replay's last row for it
  went; the store sets it and clears it when a row returns (an Undo of the Discard).

## Retention (`drizzle-document-trash.ts`)

One window (`deletionPurgeCutoff`) for both kinds.

- **Trash**: for each entry whose nodes have all been in Trash that long, one submission
  appends a `purge` record naming the delete (`writer.purge("system", { id, node })`). The
  whole subtree goes in that submission: a folder purged while a child's row stands fails the
  deferred foreign key. It waits (nothing appended) while a node outside the entry stands inside
  it, a Work has a pending record on one of its nodes, or a Work has a reviewable change on one of
  its documents (`pending-documents.ts`, checked with the documents' keys and the active draft
  rows held, which sort after the list's key).
- **A document in no view** past the window: no record exists to append. The job takes the
  lists that could reshow it, rechecks, and releases it.
- **Release** (`release-document-content.ts`): the journal, derived rows and drafts go; the
  `documents` row stays, marked `content_purged_at`, so a bound link resolves to "gone". Storage
  objects are deleted after the commit.

## Import

An import writes each document's first state into the journal under the id its create will have
(a Yjs head with no `documents` row) and keeps what else a batch worked out on its entry
(`import_entries.ahead`). Its last step makes every node a `create` record in one submission
(`../adapters/drizzle-import-reveal.ts`). See `domains/import`.
