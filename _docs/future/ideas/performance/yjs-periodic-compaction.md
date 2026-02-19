---
detail: minimal
audience: developer
---
# Future: Yjs Periodic State Compaction

**Status:** Idea (not needed for v1)
**Purpose:** Bound Yjs binary state growth for long-lived documents.

## Problem

As documents accumulate Yjs updates over months, the binary state (`Y.encodeStateAsUpdate()`) grows because it includes tombstones and metadata for all historical operations. For a very active document this could reach tens of MB.

## Proposed Solution

Periodic compaction: `Y.encodeStateAsUpdate(doc)` -> replace the stored state with a fresh encoding. This discards internal tombstones and produces a minimal representation of the current document state.

**Note:** The `DocumentCompactor` interface already includes `ReplaceState(ctx, docID, compactedState, content, aiContent)` for atomic swap of stored state with a compacted version. The interface is ready — only the trigger logic and scheduling need to be implemented.

## Open Questions

- **Trigger threshold:** Every 500-1000 updates? Or when binary size exceeds a threshold (e.g., 5MB)?
- **In-place vs historical:** Compact in-place (replace stored state) or keep historical snapshots for rollback?
- **Undo impact:** `Y.UndoManager` scope — does compaction reset undo history? If so, how to communicate the undo boundary to writers?
- **Bridge interaction:** Does the local-bridge sync need to know about compaction? (Likely no — Yjs sync protocol handles state vector reconciliation regardless.)
- **Timing:** Can compaction happen while clients are connected? (Yes — `Y.encodeStateAsUpdate()` is a read operation on the Y.Doc, but the stored state replacement needs coordination.)

## When to Revisit

- When any document's Yjs binary state exceeds 5MB
- When snapshot load time (first open) exceeds 500ms p95
- When Postgres storage cost for Yjs state becomes non-trivial

## Related

- `_docs/plans/collab-ai/spec/compaction-retention.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
