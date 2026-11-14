# domains/context FUTURE

These are deferred domain improvements. Validate the existing URI and tree
contracts before changing them.

## Manuscript ordering and agent reorder

Sibling order is currently derived from the existing name-based projection.
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

The browser sends a Copy under its own operation id with each root's `copyId` (a UUID the
command takes and mints descendants around), from a live view: a drop across systems and
Copy to… in the tree. Copy still refuses a draft placement destination (`invalid_operation`): a
draft-mode chat's copy would need a branch create, which is E2's replica intent work. A
document that exists only in a Work's draft cannot be a source for the same reason: the
listing reads the live tree.

The state-vector check compares against the draft room for a draft view, but only against
vectors a probe built. The browser sends a live document's vector from its open session and
has been checked against it; no surface sends a draft tab's yet. Before one does, compare the
draft room's vector (`drafts.copyDraft`) against a real tab's.

## Copy: preparation cost

A 200-document copy spends most of its time before the lock: reading each document's room
one after another takes about 18 ms each. Reading four at a time would cut it, at the price of
more pool connections per copy; measure under concurrent copies first.
