# Phase 1: Foundation

## Goal
Set up the word-level diffing infrastructure that will power the diff view.

## Steps

### Step 1.1: Install the `diff` library

The `diff` library (jsdiff) provides word-level diffing that's cleaner for prose than character-level algorithms.

```bash
cd frontend
pnpm add diff
pnpm add -D @types/diff
```

**Why jsdiff over diff-match-patch?**
- `diffWords()` respects word boundaries (better for prose)
- Less character-level noise
- Simpler API

---

### Step 1.2: Create the types file

Create `frontend/src/core/editor/codemirror/diffView/types.ts`:

```typescript
/**
 * Represents a single diff hunk between content and aiVersion.
 *
 * A hunk can be:
 * - Pure deletion (deletedText only)
 * - Pure insertion (insertedText only)
 * - Replacement (both deletedText and insertedText)
 */
export interface WordDiffHunk {
  /** Stable ID for React keys and tracking (content-based hash) */
  id: string

  /** Type of change */
  type: 'deletion' | 'insertion' | 'replacement'

  /**
   * Position in the DISPLAY document (aiVersion).
   * This is where decorations will be placed.
   */
  displayFrom: number
  displayTo: number

  /**
   * Position range in the baseline (content).
   * Used for accept operations.
   */
  contentRange: { from: number; to: number }

  /**
   * Position range in the AI version.
   * Used for reject operations.
   */
  aiRange: { from: number; to: number }

  /** Text from baseline that was deleted (shown as strikethrough) */
  deletedText: string

  /** Text from aiVersion that was inserted (shown as green) */
  insertedText: string
}

/**
 * Configuration for the diff view extension.
 */
export interface DiffViewConfig {
  /** Current editing mode */
  mode: 'original' | 'changes' | 'aiDraft'

  /** Baseline content (user's original) */
  baseline: string

  /** AI version (draft) */
  aiVersion: string

  /** Computed hunks (passed in to avoid recomputation) */
  hunks: WordDiffHunk[]

  /** Callback when user accepts a hunk */
  onAcceptHunk: (hunkId: string) => void

  /** Callback when user rejects a hunk */
  onRejectHunk: (hunkId: string) => void

  /** Callback when content changes in dual-doc edit mode */
  onDualDocChange: (newContent: string, newAiVersion: string) => void
}
```

---

### Step 1.3: Create the useWordDiff hook

Create `frontend/src/features/documents/hooks/useWordDiff.ts`:

```typescript
import { useMemo } from 'react'
import { diffWords, type Change } from 'diff'
import type { WordDiffHunk } from '@/core/editor/codemirror/diffView/types'

/**
 * Simple hash function for generating stable hunk IDs.
 * Uses content-based hashing so IDs stay stable across re-renders.
 */
function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36)
}

/**
 * Compute word-level diff hunks between baseline and aiVersion.
 *
 * @param baseline - The user's original content
 * @param aiVersion - The AI-modified version
 * @returns Array of hunks representing changes
 */
function computeWordDiffHunks(baseline: string, aiVersion: string): WordDiffHunk[] {
  // Get word-level diff
  const changes: Change[] = diffWords(baseline, aiVersion)

  const hunks: WordDiffHunk[] = []
  let contentPos = 0  // Position in baseline
  let aiPos = 0       // Position in aiVersion

  let i = 0
  while (i < changes.length) {
    const change = changes[i]

    // Skip unchanged text - just advance positions
    if (!change.added && !change.removed) {
      const len = change.value.length
      contentPos += len
      aiPos += len
      i++
      continue
    }

    // Found a change - collect consecutive added/removed into one hunk
    let deletedText = ''
    let insertedText = ''
    const hunkContentStart = contentPos
    const hunkAiStart = aiPos

    // Collect all consecutive changes
    while (i < changes.length) {
      const current = changes[i]

      // Stop at unchanged text
      if (!current.added && !current.removed) break

      if (current.removed) {
        deletedText += current.value
        contentPos += current.value.length
      } else if (current.added) {
        insertedText += current.value
        aiPos += current.value.length
      }

      i++
    }

    // Determine hunk type
    let type: WordDiffHunk['type']
    if (deletedText && insertedText) {
      type = 'replacement'
    } else if (deletedText) {
      type = 'deletion'
    } else {
      type = 'insertion'
    }

    // Create hunk with stable ID
    hunks.push({
      id: `hunk-${hashCode(deletedText + '|' + insertedText + '|' + hunkAiStart)}`,
      type,
      // Display position is in aiVersion (what we show in editor)
      displayFrom: hunkAiStart,
      displayTo: hunkAiStart + insertedText.length,
      contentRange: {
        from: hunkContentStart,
        to: hunkContentStart + deletedText.length,
      },
      aiRange: {
        from: hunkAiStart,
        to: hunkAiStart + insertedText.length,
      },
      deletedText,
      insertedText,
    })
  }

  return hunks
}

/**
 * Hook for computing word-level diffs between content and AI suggestions.
 *
 * @param content - Current user content (baseline)
 * @param aiVersion - AI's suggested version
 * @returns Array of diff hunks, empty if no aiVersion or identical
 *
 * @example
 * ```tsx
 * const hunks = useWordDiff(document.content, document.aiVersion)
 * // Returns array of WordDiffHunk objects
 * ```
 */
export function useWordDiff(
  content: string,
  aiVersion: string | null | undefined
): WordDiffHunk[] {
  return useMemo(() => {
    if (!aiVersion) return []
    if (content === aiVersion) return []
    return computeWordDiffHunks(content, aiVersion)
  }, [content, aiVersion])
}

/**
 * Apply an "Accept" operation to the baseline content.
 * Accepting means: use the AI's version for this hunk.
 *
 * @param content - Current baseline content
 * @param hunk - The hunk to accept
 * @returns New content with the hunk accepted
 */
export function applyAcceptHunk(content: string, hunk: WordDiffHunk): string {
  return (
    content.slice(0, hunk.contentRange.from) +
    hunk.insertedText +
    content.slice(hunk.contentRange.to)
  )
}

/**
 * Apply a "Reject" operation to the AI version.
 * Rejecting means: revert to the user's original for this hunk.
 *
 * @param aiVersion - Current AI version
 * @param hunk - The hunk to reject
 * @returns New aiVersion with the hunk rejected
 */
export function applyRejectHunk(aiVersion: string, hunk: WordDiffHunk): string {
  return (
    aiVersion.slice(0, hunk.aiRange.from) +
    hunk.deletedText +
    aiVersion.slice(hunk.aiRange.to)
  )
}

// Also export the computation function for use outside React
export { computeWordDiffHunks }
```

---

### Step 1.4: Create the diffView directory structure

```bash
mkdir -p frontend/src/core/editor/codemirror/diffView
```

Create `frontend/src/core/editor/codemirror/diffView/index.ts` (placeholder for now):

```typescript
/**
 * Diff View Extension
 *
 * Provides word-level inline diff display for AI suggestions.
 * Shows deletions as red strikethrough, insertions as green underline.
 */

// Re-export types
export * from './types'

// Extension will be added in Phase 2
// export { diffViewExtension } from './plugin'
```

---

### Step 1.5: Write a simple test

Create a quick test to verify the diff computation works:

```typescript
// Test in browser console or add to a test file
import { computeWordDiffHunks } from '@/features/documents/hooks/useWordDiff'

const baseline = "She felt sad. Everything looked the same."
const aiVersion = "A heavy melancholia settled in her chest. The landscape remained unchanged."

const hunks = computeWordDiffHunks(baseline, aiVersion)
console.log('Hunks:', hunks)

// Expected: 2 replacement hunks
// 1. "She felt sad." → "A heavy melancholia settled in her chest."
// 2. "Everything looked the same." → "The landscape remained unchanged."
```

---

## Verification Checklist

Before moving to Phase 2, verify:

- [ ] `pnpm add diff @types/diff` completed successfully
- [ ] `types.ts` created with `WordDiffHunk` and `DiffViewConfig` interfaces
- [ ] `useWordDiff.ts` created with hook and helper functions
- [ ] `diffView/index.ts` created as placeholder
- [ ] Quick test shows correct hunk computation

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/package.json` | Modified (added `diff`, `@types/diff`) |
| `frontend/src/core/editor/codemirror/diffView/types.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Created |
| `frontend/src/features/documents/hooks/useWordDiff.ts` | Created |

## Next Step

→ Continue to `02-decorations.md` to build the CodeMirror ViewPlugin
