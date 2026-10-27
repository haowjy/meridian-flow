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

## Copy: client intent and draft destinations

The server Copy command exists (`copy/`); the browser's Copy intent does not. K2 models each
copied root as a create-shaped replica record, so a request may mint each root's identity
(`copyId`, a UUID); the command takes it and mints descendants itself. K2 should send it and
record in `DECISIONS.md` if its design rules that out. Copy still refuses a draft placement destination (`invalid_operation`): a
draft-mode chat's copy would need a branch create, which is E2's replica intent work. A
document that exists only in a Work's draft cannot be a source for the same reason: the
listing reads the live tree.

The state-vector check compares against the draft room for a draft view, but only against
vectors a probe built. Before K2 sends one for a draft tab, compare the draft room's vector
(`drafts.copyDraft`) against a real tab's.

## Copy: preparation cost and the catalog reconcile

A 200-document copy spends most of its time before the lock: reading each document's room
one after another takes about 18 ms each. Reading four at a time would cut it, at the price of
more pool connections per copy; measure under concurrent copies first.

`ContextCatalogMutationPort.refreshSources` reconciles the whole project scope against the
stored catalog on every write and holds the catalog head lock to the end of the transaction,
so every write in a project waits behind every other and each write costs more as the
project grows (on a dev stack a `doc put` took about 130 ms in a project of 200 documents and
over a second in one of 4,400). A copy into a folder that does not exist yet pays it twice,
once to create the folder path and once for the tree. Refreshing only the invalidated roots,
and as late in the transaction as possible, would make a write's cost independent of the
project and shorten the head-lock hold.
