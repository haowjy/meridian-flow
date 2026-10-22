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
