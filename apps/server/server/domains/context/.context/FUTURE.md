# domains/context FUTURE

These are deferred domain improvements. Validate the existing URI and tree
contracts before changing them.

## Batch revision availability

`DocumentRevisions.current` reads each revision per document (the access decisions come
from one `listAccess`). Compaction may still issue per-document lookups. Measure compaction and multi-
document revision latency before changing the call shape.

## Owner-name collision lookup

`adapters/owner-lookup.ts` bounds returned name candidates, but its normalized-
name predicate can still scan a project's Works on explicit Scratch receipts.
Measure query plans at representative Work counts before changing it. If material,
index one shared normalized-name key; keep corrections and labels in the existing
owner resolver, without adding address aliases.

## Document purge cleanup and sweep cost

Object-store deletion runs after a document purge commits. A failed object deletion is logged
but is not retried, because the document no longer enters a later purge sweep. Add durable retry
ownership before treating physical object erasure as guaranteed.

The purge batch bounds completed purges, not inspected candidates. Documents held by pending Work
changes can make each sweep scan the full overdue backlog. Measure that backlog before changing the
query or adding a held-candidate cursor.

## Copy: preparation cost

A 200-document copy spends most of its time before the lock: reading each document's room
one after another takes about 18 ms each. Reading four at a time would cut it, at the price of
more pool connections per copy; measure under concurrent copies first.

## A kept file's extension is guessed from its name

The tree's records carry a name, not an extension. The app's rows and the
`tree_nodes.extension` column (written from `packages/project-tree/src/rows.ts` by
`adapters/tree-list-rows.ts`, with the generated `stem` beside it) derive it with
`entryExtension` (contracts): exact for a document, through `parseDocumentFilename`, but
the last dot of the name for a kept file (kind `file`). A kept file named `Ver 1.2` with no
real extension therefore reads as extension `2`, and renaming it to `Ver 2` stores
`Ver 2.2`. Carrying the extension on the tree record at upload would remove the guess.

## Renaming a kept file to another type is skipped silently

Renaming `backup.zip` to `backup.png` in the tree sends a rename with filetype `image`.
Replay skips any rename that sets a filetype that is not tracked text
(`type-not-editable` in `packages/project-tree/src/replay.ts`), so the tree keeps
`backup.zip`, offers Undo, and says nothing. Either the rename keeps the name and drops
the type change, or the writer is told the type stays.
