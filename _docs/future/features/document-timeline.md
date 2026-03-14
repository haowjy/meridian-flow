---
detail: minimal
audience: developer, architect
status: future
depends-on: _docs/plans/collab-review-v2/spec/append-only-persistence.md
---

# Document Timeline

A history scrubber that lets writers see how their chapter evolved over time.

## Problem

The current persistence model overwrites the merged Yjs state every 2 seconds. Individual updates are discarded — there is no record of what changed, when, or by whom. Writers cannot review their document's history at any meaningful granularity.

## Feature

Writers scrub a timeline slider to view their document at any past point. Each position on the timeline corresponds to a specific Yjs update in the log.

| Capability | Description |
|------------|-------------|
| Scrub | Drag a slider to replay history at any granularity |
| Attribution | Color-coded human vs AI contributions per update |
| Diff | Compare any two points in time |
| Restore | Append an inverse update to revert to a past state |

## Dependency

This feature requires the append-only Yjs update log described in `_docs/plans/collab-review-v2/spec/append-only-persistence.md`. The current snapshot-overwrite model cannot support it.

## Notes

- **Restore is append-only** — restoring to a past state appends an inverse update, it does not rewind the log. This is required by Yjs CRDT semantics (inverse updates are order-dependent; the log is never mutated).
- **Attribution** comes from the `origin` and `user_id` fields on each `document_updates` row.
- Per-update granularity is only possible once the infrastructure migration is complete. Snapshots alone cannot reconstruct intermediate states.

## Related

- `_docs/plans/collab-review-v2/spec/append-only-persistence.md` — required infrastructure
- `_docs/technical/collab/yjs-state-lifecycle.md` — current persistence model
