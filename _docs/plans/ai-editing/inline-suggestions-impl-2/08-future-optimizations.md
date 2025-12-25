# Future Optimizations

> **Status**: Do NOT implement these in v1. Document for future reference only.

These optimizations may be needed if performance becomes an issue with large documents or many hunks.

## Performance Optimizations

### 1. Cache Hunks + CM6 Position Mapping

**Problem**: `extractHunks()` runs on every transaction, scanning the entire document for PUA markers.

**Solution**: Cache hunk positions and use CM6's `ChangeSet.mapPos()` to update them incrementally:

```typescript
// Sketch
class HunkCache {
  private hunks: MergedHunk[] = []

  update(tr: Transaction) {
    if (!tr.docChanged) return

    // Map existing positions through the changes
    this.hunks = this.hunks.map(hunk => ({
      ...hunk,
      from: tr.changes.mapPos(hunk.from),
      to: tr.changes.mapPos(hunk.to),
      // ... map other positions
    }))

    // Re-extract only if mapping fails (markers were edited)
  }
}
```

**Complexity**: Medium
**When to implement**: If profiling shows `extractHunks()` is a bottleneck (>5ms on typical documents)

### 2. Throttle Decoration Rebuilds

**Problem**: Rapid typing triggers decoration rebuilds on every keystroke.

**Solution**: Debounce decoration updates during active typing:

```typescript
// In ViewPlugin update()
if (update.docChanged) {
  this.scheduleRebuild() // 50ms debounce
}
```

**Complexity**: Low
**When to implement**: If users report lag during typing in diff view

### 3. Lazy Hunk Extraction

**Problem**: Hunks are extracted even when not needed (e.g., during normal typing).

**Solution**: Only extract hunks when the UI actually needs them:
- Navigation (prev/next hunk)
- Accept/reject operations
- Save (parse merged document)

**Complexity**: Low
**When to implement**: If hunk extraction becomes expensive

### 4. Binary Search for Position Lookups

**Problem**: `isInDeletionRegion()` and `findHunkAtPosition()` do linear scans.

**Solution**: Since hunks are sorted by position, use binary search:

```typescript
function findHunkAtPosition(pos: number, hunks: MergedHunk[]): MergedHunk | null {
  let low = 0, high = hunks.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const hunk = hunks[mid]
    if (pos < hunk.from) high = mid - 1
    else if (pos > hunk.to) low = mid + 1
    else return hunk
  }
  return null
}
```

**Complexity**: Low
**When to implement**: If documents have 50+ hunks and position lookups become slow

## Already Implemented

- **Viewport culling**: Phase 2 skips decorations for hunks outside the visible viewport
