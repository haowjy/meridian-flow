# domains/context FUTURE

These are deferred domain improvements. Validate the existing URI, tree, and
catalog contracts before changing them.

## Manuscript ordering and agent reorder

Catalog order is currently derived from the existing name-based projection.
Design an explicit manuscript binder order, then add its persistence, route,
ContextPort seam, and agent move/reorder behavior as one coherent change.

## Batch revision availability

`DocumentRevisions.current` and compaction have batch-capable availability
ports but may still issue per-document lookups. Measure compaction and multi-
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

## Copy: client intent, root identities and draft destinations

The server Copy command exists (`copy/`); the browser's Copy intent does not. K2 models each
copied root as a create-shaped replica record, so it may want client-minted root identities
for optimistic projection: the command mints every identity itself today, and the receipt
carries them. Copy also refuses a draft placement destination (`invalid_operation`): a
draft-mode chat's copy would need a branch create, which is E2's replica intent work. A
document that exists only in a Work's draft cannot be a source for the same reason: the
listing reads the live tree.

The state-vector check does not run for draft views. Before K2 sends a vector for a draft
tab, compare the draft room's vector (`drafts.copyDraft`) against a real tab's.
