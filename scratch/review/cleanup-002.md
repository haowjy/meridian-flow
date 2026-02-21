# Cleanup 002: Naming inconsistency — "hunk" in Phase 1 while types remain "chunk"

**Category:** Architecture / Project Conventions
**File:** `_docs/designs/inline-review-v2.md` (Phase 1 + Phase 2)
**Severity:** Medium — creates a mixed vocabulary that makes the codebase harder to navigate

## What's Wrong

Phase 1 introduces new code using "hunk" terminology:
- `HunkActionWidget` (class name)
- `HunkHoverManager` (class name)
- `hunkHoverPlugin` (export name)
- `data-hunk-id` (DOM attribute)
- CSS classes: `.cm-review-hunk-*` (mentioned in Phase 2 table)

But all existing types stay as "chunk" until Phase 2:
- `ReviewChunk` (type)
- `chunk.id` (property)
- `InlineReviewCallbacks.onAcceptChunk` / `onRejectChunk`
- `activeChunkIndex` (state field)
- `resolveChunk` (state effect)

This means after Phase 1, the codebase has **both vocabularies coexisting**:
```typescript
// Phase 1 result: mixed vocabulary
class HunkActionWidget {
  constructor(private chunk: ReviewChunk) { }  // "hunk" widget wrapping "chunk" type
  // ...
  container.dataset.hunkId = this.chunk.id;    // "hunk" attribute from "chunk" id
}
```

Phase 2's rename won't be a simple find-replace because Phase 1 already uses hunk terminology — the renamer must know which "hunk" references are new (Phase 1) and which "chunk" references need renaming (existing).

## Suggested Fix

**Option A (preferred):** Keep Phase 1 using "chunk" names (`ChunkActionWidget` renamed, `ChunkHoverManager`, `data-chunk-id`). Phase 2 renames everything atomically.

**Option B:** Merge Phase 2 into Phase 1 — rename as part of the same slice. This is a larger change but avoids the mixed-vocabulary intermediate state.

**Option C:** If "hunk" is the final target name, Phase 1 should document the intentional mixed state and Phase 2 must be done in the immediately following PR (not deferred).
