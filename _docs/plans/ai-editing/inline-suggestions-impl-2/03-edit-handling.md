# Phase 3: Edit Handling

## Goal
Implement mode-aware editing that:
1. Blocks edits in red (deletion) regions in Changes mode
2. Routes edits in green (insertion) regions to `aiVersion` only
3. Routes edits outside hunks to BOTH `content` and `aiVersion`

## Key Concept: Position Mapping

When `content` and `aiVersion` have different lengths, we need to map positions between them:

```
content:    "She felt sad. More text here..."
             ^--deletion--^
aiVersion:  "A heavy melancholia. More text here..."
             ^--insertion------^

Position 0 in aiVersion maps to position 0 in content
Position 20 in aiVersion (after insertion) maps to position 14 in content (after deletion)
```

We build an **offset table** from the hunks to perform this mapping.

## Steps

### Step 3.1: Create the position mapping utilities

Create `frontend/src/core/editor/codemirror/diffView/positionMapping.ts`:

```typescript
import type { WordDiffHunk } from './types'

/**
 * Entry in the offset table.
 * Records the cumulative position difference at each hunk boundary.
 */
interface OffsetEntry {
  /** Position in aiVersion (display document) */
  aiPos: number
  /** Corresponding position in content (baseline) */
  contentPos: number
  /** Cumulative offset: contentPos - aiPos would be at this point */
  offset: number
}

/**
 * Build an offset table from hunks for position mapping.
 *
 * The offset table records how positions diverge between content and aiVersion
 * at each hunk boundary, allowing us to map positions between documents.
 *
 * @param hunks - Sorted array of diff hunks
 * @returns Offset table entries
 */
export function buildOffsetTable(hunks: WordDiffHunk[]): OffsetEntry[] {
  const table: OffsetEntry[] = [
    { aiPos: 0, contentPos: 0, offset: 0 }
  ]

  let cumulativeOffset = 0

  for (const hunk of hunks) {
    // The deletion/insertion causes positions to diverge
    const deletionLen = hunk.deletedText.length
    const insertionLen = hunk.insertedText.length

    // After this hunk, content positions are offset by this much relative to aiVersion
    cumulativeOffset += deletionLen - insertionLen

    table.push({
      aiPos: hunk.aiRange.to,
      contentPos: hunk.contentRange.to,
      offset: cumulativeOffset,
    })
  }

  return table
}

/**
 * Map a position from aiVersion to content.
 *
 * @param aiPos - Position in aiVersion (display document)
 * @param table - Offset table from buildOffsetTable()
 * @param hunks - Original hunks for boundary checking
 * @returns Position in content, or null if inside an insertion
 */
export function aiPosToContentPos(
  aiPos: number,
  table: OffsetEntry[],
  hunks: WordDiffHunk[]
): number | null {
  // Check if position is inside an insertion (green region)
  for (const hunk of hunks) {
    if (aiPos > hunk.aiRange.from && aiPos < hunk.aiRange.to) {
      // Inside insertion - no corresponding content position
      return null
    }
  }

  // Find the appropriate offset entry
  let offset = 0
  for (const entry of table) {
    if (entry.aiPos <= aiPos) {
      offset = entry.offset
    } else {
      break
    }
  }

  return aiPos + offset
}

/**
 * Map a position from content to aiVersion.
 *
 * @param contentPos - Position in content (baseline)
 * @param table - Offset table
 * @param hunks - Original hunks for boundary checking
 * @returns Position in aiVersion, or null if inside a deletion
 */
export function contentPosToAiPos(
  contentPos: number,
  table: OffsetEntry[],
  hunks: WordDiffHunk[]
): number | null {
  // Check if position is inside a deletion (red region)
  for (const hunk of hunks) {
    if (contentPos > hunk.contentRange.from && contentPos < hunk.contentRange.to) {
      // Inside deletion - no corresponding aiVersion position
      return null
    }
  }

  // Find the appropriate offset entry
  let offset = 0
  for (const entry of table) {
    if (entry.contentPos <= contentPos) {
      offset = entry.offset
    } else {
      break
    }
  }

  return contentPos - offset
}

/**
 * Check what region a position falls into.
 *
 * @param aiPos - Position in aiVersion
 * @param hunks - Diff hunks
 * @returns Region type and associated hunk if any
 */
export function getPositionRegion(
  aiPos: number,
  hunks: WordDiffHunk[]
): { type: 'insertion' | 'deletion-boundary' | 'outside'; hunk?: WordDiffHunk } {
  for (const hunk of hunks) {
    // Check if in insertion region
    if (aiPos >= hunk.aiRange.from && aiPos <= hunk.aiRange.to) {
      // At or after insertion start, at or before insertion end
      if (hunk.insertedText) {
        return { type: 'insertion', hunk }
      }
    }

    // Check if at deletion boundary (where ghost widget is)
    if (aiPos === hunk.displayFrom && hunk.deletedText) {
      return { type: 'deletion-boundary', hunk }
    }
  }

  return { type: 'outside' }
}

/**
 * Apply an edit to both documents at corresponding positions.
 *
 * @param content - Current content
 * @param aiVersion - Current aiVersion
 * @param aiFrom - Edit start position in aiVersion
 * @param aiTo - Edit end position in aiVersion
 * @param insertText - Text to insert
 * @param table - Offset table
 * @param hunks - Diff hunks
 * @returns New content and aiVersion, or null if edit is blocked
 */
export function applyDualEdit(
  content: string,
  aiVersion: string,
  aiFrom: number,
  aiTo: number,
  insertText: string,
  table: OffsetEntry[],
  hunks: WordDiffHunk[]
): { content: string; aiVersion: string } | null {
  // Map positions to content
  const contentFrom = aiPosToContentPos(aiFrom, table, hunks)
  const contentTo = aiPosToContentPos(aiTo, table, hunks)

  // If mapping fails, one of the positions is inside a hunk
  if (contentFrom === null || contentTo === null) {
    return null
  }

  // Apply edit to both documents
  const newContent =
    content.slice(0, contentFrom) + insertText + content.slice(contentTo)
  const newAiVersion =
    aiVersion.slice(0, aiFrom) + insertText + aiVersion.slice(aiTo)

  return { content: newContent, aiVersion: newAiVersion }
}
```

---

### Step 3.2: Create the edit filter

Create `frontend/src/core/editor/codemirror/diffView/editFilter.ts`:

```typescript
/**
 * Edit Filter for Diff View
 *
 * Controls which edits are allowed based on the current mode and position.
 */

import { EditorState, type TransactionSpec } from '@codemirror/state'
import { diffConfigFacet } from './plugin'
import { buildOffsetTable, getPositionRegion, applyDualEdit } from './positionMapping'

/**
 * Transaction filter that enforces mode-aware editing rules.
 *
 * In 'changes' mode:
 * - Edits in green (insertion) regions → allowed (edits aiVersion)
 * - Edits in red (deletion) regions → BLOCKED
 * - Edits outside hunks → triggers dual-doc update callback
 *
 * In other modes, all edits pass through normally.
 */
export const diffEditFilter = EditorState.transactionFilter.of((tr) => {
  // Pass through non-editing transactions
  if (!tr.docChanged) return tr

  const config = tr.startState.facet(diffConfigFacet)

  // Only filter in 'changes' mode
  if (config.mode !== 'changes') return tr

  // No hunks = no diff view active
  if (config.hunks.length === 0) return tr

  // Analyze each change in the transaction
  let shouldBlock = false
  let hasDualDocEdit = false
  const dualEdits: Array<{
    from: number
    to: number
    insert: string
  }> = []

  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    // Check what region the edit starts in
    const region = getPositionRegion(fromA, config.hunks)

    if (region.type === 'deletion-boundary') {
      // Editing at deletion boundary - BLOCK
      // (User is trying to edit the ghost deletion text)
      shouldBlock = true
      return
    }

    if (region.type === 'insertion') {
      // Editing in insertion region - ALLOW (edits aiVersion only)
      // No special handling needed, transaction proceeds normally
      return
    }

    // Edit is outside hunks - need to update BOTH documents
    hasDualDocEdit = true
    dualEdits.push({
      from: fromA,
      to: toA,
      insert: inserted.toString(),
    })
  })

  // Block if any edit was in a blocked region
  if (shouldBlock) {
    // Return empty array to cancel the transaction
    return []
  }

  // Handle dual-document edits
  if (hasDualDocEdit && dualEdits.length > 0) {
    const table = buildOffsetTable(config.hunks)

    // Apply edits to both documents
    let newContent = config.baseline
    let newAiVersion = config.aiVersion

    for (const edit of dualEdits) {
      const result = applyDualEdit(
        newContent,
        newAiVersion,
        edit.from,
        edit.to,
        edit.insert,
        table,
        config.hunks
      )

      if (result === null) {
        // Edit crosses hunk boundary - block it
        return []
      }

      newContent = result.content
      newAiVersion = result.aiVersion
    }

    // Notify parent component of dual-doc change
    // This will be handled by the store to update both documents
    config.onDualDocChange(newContent, newAiVersion)

    // Let the transaction proceed (updates aiVersion in editor)
    return tr
  }

  // No special handling needed
  return tr
})
```

---

### Step 3.3: Add the filter to the extension bundle

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

Add the import at the top:
```typescript
import { diffEditFilter } from './editFilter'
```

Update `createDiffViewExtension`:
```typescript
export function createDiffViewExtension(config: DiffViewConfig): Extension {
  return [
    diffConfigFacet.of(config),
    diffViewPlugin,
    diffEditFilter,  // Add this line
    // Keymap will be added in Phase 5
  ]
}
```

---

### Step 3.4: Update the index.ts exports

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides word-level inline diff display for AI suggestions.
 * Shows deletions as red strikethrough (ghost widgets),
 * insertions as green underline (mark decorations).
 *
 * Also provides mode-aware edit filtering:
 * - Changes mode: blocks edits in deletion regions, syncs edits outside hunks
 * - Original/AI Draft modes: edits pass through normally
 */

// Types
export * from './types'

// Plugin and extension
export {
  diffViewPlugin,
  diffConfigFacet,
  createDiffViewExtension,
} from './plugin'

// Position mapping utilities (for external use if needed)
export {
  buildOffsetTable,
  aiPosToContentPos,
  contentPosToAiPos,
  getPositionRegion,
  applyDualEdit,
} from './positionMapping'

// Edit filter (auto-included in extension, exported for testing)
export { diffEditFilter } from './editFilter'

// Widget (for testing/customization)
export { DeletionWidget } from './DeletionWidget'
```

---

### Step 3.5: Test the edit handling

Test scenarios to verify:

**Test 1: Edit in insertion (green) region**
- Click inside green underlined text
- Type some characters
- ✅ Should succeed, modifying aiVersion

**Test 2: Edit at deletion (red) boundary**
- Click right before/after red strikethrough text
- Try to type or delete
- ✅ Should be blocked (no change happens)

**Test 3: Edit outside hunks**
- Click in unchanged text area
- Type some characters
- ✅ Should succeed
- ✅ Both content AND aiVersion should update (check via callback)

```typescript
// Test code for EditorPanel
const handleDualDocChange = (newContent: string, newAiVersion: string) => {
  console.log('Dual doc change:')
  console.log('  New content:', newContent)
  console.log('  New aiVersion:', newAiVersion)

  // Verify both changed identically
  // (In production, this would update the store)
}
```

---

## Understanding the Flow

```
User types in editor
        │
        ▼
┌───────────────────────────────┐
│   diffEditFilter intercepts   │
│   the transaction             │
└───────────────────────────────┘
        │
        ▼
┌───────────────────────────────┐
│  Check: what region is the    │
│  cursor in?                   │
└───────────────────────────────┘
        │
        ├─── In deletion region ──► BLOCK (return [])
        │
        ├─── In insertion region ──► ALLOW (return tr)
        │
        └─── Outside hunks ──► Map positions
                                    │
                                    ▼
                              ┌─────────────────────┐
                              │ Apply edit to both  │
                              │ content + aiVersion │
                              └─────────────────────┘
                                    │
                                    ▼
                              ┌─────────────────────┐
                              │ Call onDualDocChange│
                              │ callback            │
                              └─────────────────────┘
                                    │
                                    ▼
                              ALLOW (return tr)
```

---

## Verification Checklist

Before moving to Phase 4, verify:

- [ ] `positionMapping.ts` created with offset table utilities
- [ ] `editFilter.ts` created with transaction filter
- [ ] Extension bundle updated to include edit filter
- [ ] Edits in green regions work normally
- [ ] Edits at red boundaries are blocked
- [ ] Edits outside hunks trigger `onDualDocChange` callback
- [ ] Both documents update correctly for outside-hunk edits

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/core/editor/codemirror/diffView/positionMapping.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/editFilter.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/plugin.ts` | Modified |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Modified |

## Next Step

→ Continue to `04-state-sync.md` to extend the store and sync service
