# Phase 1: Foundation

## Goal

Create the core utilities for building and parsing merged documents with PUA markers. This phase establishes the data transformation layer between storage format (separate content/aiVersion) and editor format (merged document).

## What You're Building

1. **PUA marker constants** - Unicode markers for del/ins regions
2. **`buildMergedDocument()`** - Combines content + aiVersion into marked document
3. **`parseMergedDocument()`** - Extracts content + aiVersion from marked document
4. **Hunk type definitions** - TypeScript interfaces for diff regions

## Steps

### Step 1.1: Create the markers and types file

Create `frontend/src/features/documents/utils/mergedDocument.ts`:

```typescript
import DiffMatchPatch from 'diff-match-patch'

// =============================================================================
// PUA MARKERS
// =============================================================================

/**
 * Unicode Private Use Area markers for diff regions.
 * These characters never appear in normal text, so no escaping needed.
 */
export const MARKERS = {
  DEL_START: '\uE000',  // Start of deletion (original text)
  DEL_END:   '\uE001',  // End of deletion
  INS_START: '\uE002',  // Start of insertion (AI text)
  INS_END:   '\uE003',  // End of insertion
} as const

/**
 * Regex to match a complete hunk (DEL followed by INS).
 * Captures: [full match, deletion content, insertion content]
 */
export const HUNK_REGEX = new RegExp(
  `${MARKERS.DEL_START}([^${MARKERS.DEL_END}]*)${MARKERS.DEL_END}` +
  `${MARKERS.INS_START}([^${MARKERS.INS_END}]*)${MARKERS.INS_END}`,
  'g'
)

/**
 * Regex to match any marker character.
 */
export const ANY_MARKER_REGEX = /[\uE000-\uE003]/

// =============================================================================
// TYPES
// =============================================================================

/**
 * A diff hunk in the merged document.
 * Used for decoration positioning and accept/reject operations.
 */
export interface MergedHunk {
  /** Unique ID for React keys (content-based hash) */
  id: string

  /** Start position in merged document (includes DEL_START marker) */
  from: number

  /** End position in merged document (after INS_END marker) */
  to: number

  /** Position of DEL_START marker */
  delStart: number

  /** Position of DEL_END marker */
  delEnd: number

  /** Position of INS_START marker */
  insStart: number

  /** Position of INS_END marker */
  insEnd: number

  /** The deleted text (between DEL markers, excluding markers) */
  deletedText: string

  /** The inserted text (between INS markers, excluding markers) */
  insertedText: string
}

/**
 * Result of parsing a merged document.
 */
export interface ParsedDocument {
  /** Baseline content (with AI changes removed) */
  content: string

  /** AI version (with deletions removed), or null if no AI changes remain */
  aiVersion: string | null

  /** Whether the document has any remaining hunks */
  hasChanges: boolean
}

// =============================================================================
// BUILD MERGED DOCUMENT
// =============================================================================

const dmp = new DiffMatchPatch()

/**
 * Simple hash function for generating stable hunk IDs.
 */
function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

/**
 * Build a merged document from content and aiVersion.
 *
 * The merged document contains both texts with PUA markers indicating
 * which parts are deletions (from content) and insertions (from aiVersion).
 *
 * @param content - The baseline content (user's original)
 * @param aiVersion - The AI-modified version
 * @returns Merged document string with PUA markers
 *
 * @example
 * ```typescript
 * const merged = buildMergedDocument(
 *   "She felt sad. The rain fell.",
 *   "A heavy melancholia. The rain continued."
 * )
 * // Result: "\uE000She felt sad.\uE001\uE002A heavy melancholia.\uE003 The rain \uE000fell\uE001\uE002continued\uE003."
 * ```
 */
export function buildMergedDocument(
  content: string,
  aiVersion: string
): string {
  // If identical, no markers needed
  if (content === aiVersion) {
    return content
  }

  // Compute a character-level diff, then clean it up to be more human-readable.
  // - diff_cleanupSemantic: reduces noisy tiny edits by merging/simplifying operations.
  // - diff_cleanupSemanticLossless: shifts edit boundaries to nicer word/whitespace/punctuation edges.
  const diffs = dmp.diff_main(content, aiVersion)
  dmp.diff_cleanupSemantic(diffs)
  dmp.diff_cleanupSemanticLossless(diffs)

  // Build merged document with markers
  const parts: string[] = []
  let i = 0

  while (i < diffs.length) {
    const [op, text] = diffs[i]

    if (op === 0) {
      // Unchanged text - add as-is
      parts.push(text)
      i++
    } else if (op === -1) {
      // Deletion from content
      // Check if followed by insertion (replacement)
      const nextDiff = diffs[i + 1]
      if (nextDiff && nextDiff[0] === 1) {
        // Replacement: deletion followed by insertion
        parts.push(
          MARKERS.DEL_START + text + MARKERS.DEL_END +
          MARKERS.INS_START + nextDiff[1] + MARKERS.INS_END
        )
        i += 2
      } else {
        // Pure deletion (no replacement)
        parts.push(
          MARKERS.DEL_START + text + MARKERS.DEL_END +
          MARKERS.INS_START + MARKERS.INS_END  // Empty insertion
        )
        i++
      }
    } else if (op === 1) {
      // Pure insertion (no deletion)
      parts.push(
        MARKERS.DEL_START + MARKERS.DEL_END +  // Empty deletion
        MARKERS.INS_START + text + MARKERS.INS_END
      )
      i++
    }
  }

  return parts.join('')
}

// =============================================================================
// PARSE MERGED DOCUMENT
// =============================================================================

/**
 * Parse a merged document back into content and aiVersion.
 *
 * @param merged - The merged document with PUA markers
 * @returns Parsed content and aiVersion (clean markdown, no markers)
 *
 * @example
 * ```typescript
 * const { content, aiVersion } = parseMergedDocument(merged)
 * // content: "She felt sad. The rain fell."  (baseline)
 * // aiVersion: "A heavy melancholia. The rain continued."  (AI version)
 * ```
 */
export function parseMergedDocument(merged: string): ParsedDocument {
  // Check if any markers exist
  const hasMarkers = ANY_MARKER_REGEX.test(merged)

  if (!hasMarkers) {
    // No markers = no AI changes (either never had them or all resolved)
    return {
      content: merged,
      aiVersion: null,
      hasChanges: false,
    }
  }

  // Build content: keep DEL content, remove INS content
  const content = merged
    // Remove INS regions entirely (including content)
    .replace(new RegExp(
      `${MARKERS.INS_START}[^${MARKERS.INS_END}]*${MARKERS.INS_END}`,
      'g'
    ), '')
    // Keep DEL content but remove markers
    .replace(new RegExp(MARKERS.DEL_START, 'g'), '')
    .replace(new RegExp(MARKERS.DEL_END, 'g'), '')

  // Build aiVersion: keep INS content, remove DEL content
  const aiVersion = merged
    // Remove DEL regions entirely (including content)
    .replace(new RegExp(
      `${MARKERS.DEL_START}[^${MARKERS.DEL_END}]*${MARKERS.DEL_END}`,
      'g'
    ), '')
    // Keep INS content but remove markers
    .replace(new RegExp(MARKERS.INS_START, 'g'), '')
    .replace(new RegExp(MARKERS.INS_END, 'g'), '')

  return {
    content,
    aiVersion,
    hasChanges: true,
  }
}

// =============================================================================
// HUNK EXTRACTION
// =============================================================================

/**
 * Extract all hunks from a merged document.
 * Used for decoration positioning and navigation.
 *
 * @param merged - The merged document with PUA markers
 * @returns Array of hunks with positions and content
 */
export function extractHunks(merged: string): MergedHunk[] {
  const hunks: MergedHunk[] = []

  // Reset regex state
  HUNK_REGEX.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = HUNK_REGEX.exec(merged)) !== null) {
    const fullMatch = match[0]
    const deletedText = match[1]
    const insertedText = match[2]

    const from = match.index
    const to = from + fullMatch.length

    // Calculate marker positions within the hunk
    const delStart = from
    const delEnd = from + 1 + deletedText.length  // Index of DEL_END marker
    const insStart = delEnd + 1  // Index of INS_START marker
    const insEnd = to - 1  // Index of INS_END marker

    hunks.push({
      // Include position to avoid collisions when identical replacements repeat.
      id: `hunk-${hashCode(`${from}|${deletedText}|${insertedText}`)}`,
      from,
      to,
      delStart,
      delEnd,
      insStart,
      insEnd,
      deletedText,
      insertedText,
    })
  }

  return hunks
}

// =============================================================================
// ACCEPT / REJECT OPERATIONS
// =============================================================================

/**
 * Accept a single hunk - keep the AI text, remove the original.
 * Returns the text that should replace the hunk region.
 *
 * @param hunk - The hunk to accept
 * @returns Text to insert (the insertion content without markers)
 */
export function getAcceptReplacement(hunk: MergedHunk): string {
  return hunk.insertedText
}

/**
 * Reject a single hunk - keep the original text, remove the AI version.
 * Returns the text that should replace the hunk region.
 *
 * @param hunk - The hunk to reject
 * @returns Text to insert (the deletion content without markers)
 */
export function getRejectReplacement(hunk: MergedHunk): string {
  return hunk.deletedText
}

/**
 * Accept all hunks - replace entire document with AI version.
 *
 * @param merged - The merged document
 * @returns Document with all AI changes accepted
 */
export function acceptAllHunks(merged: string): string {
  return merged.replace(HUNK_REGEX, (_match, _del, ins) => ins)
}

/**
 * Reject all hunks - replace entire document with original version.
 *
 * @param merged - The merged document
 * @returns Document with all AI changes rejected
 */
export function rejectAllHunks(merged: string): string {
  return merged.replace(HUNK_REGEX, (_match, del, _ins) => del)
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if a position is inside a deletion region (read-only).
 *
 * @param pos - Position in merged document
 * @param hunks - Array of hunks
 * @returns True if position is in a DEL region (should be read-only)
 */
export function isInDeletionRegion(pos: number, hunks: MergedHunk[]): boolean {
  for (const hunk of hunks) {
    // DEL region: from delStart to delEnd (inclusive of markers)
    if (pos >= hunk.delStart && pos <= hunk.delEnd) {
      return true
    }
  }
  return false
}

/**
 * Check if a position is inside an insertion region (editable).
 *
 * @param pos - Position in merged document
 * @param hunks - Array of hunks
 * @returns The hunk if position is in an INS region, null otherwise
 */
export function getInsertionHunk(
  pos: number,
  hunks: MergedHunk[]
): MergedHunk | null {
  for (const hunk of hunks) {
    // INS region: from insStart to insEnd (between markers)
    if (pos > hunk.insStart && pos < hunk.insEnd) {
      return hunk
    }
  }
  return null
}

/**
 * Find which hunk contains a position (if any).
 *
 * @param pos - Position in merged document
 * @param hunks - Array of hunks
 * @returns The containing hunk, or null if outside all hunks
 */
export function findHunkAtPosition(
  pos: number,
  hunks: MergedHunk[]
): MergedHunk | null {
  for (const hunk of hunks) {
    if (pos >= hunk.from && pos <= hunk.to) {
      return hunk
    }
  }
  return null
}
```

---

### Step 1.2: Add tests for the utilities

Create test cases to verify the functions work correctly:

```typescript
// Test: buildMergedDocument
const content = "She felt sad. The rain fell."
const aiVersion = "A heavy melancholia. The rain continued."

const merged = buildMergedDocument(content, aiVersion)
console.log('Merged:', JSON.stringify(merged))
// Should contain \uE000...\uE001\uE002...\uE003 markers

// Test: parseMergedDocument
const parsed = parseMergedDocument(merged)
console.log('Parsed content:', parsed.content)
console.log('Parsed aiVersion:', parsed.aiVersion)
// Should match original content and aiVersion

// Test: extractHunks
const hunks = extractHunks(merged)
console.log('Hunks:', hunks.length)
// Should find the hunks with correct positions

// Test: acceptAllHunks
const accepted = acceptAllHunks(merged)
console.log('Accepted:', accepted)
// Should equal aiVersion

// Test: rejectAllHunks
const rejected = rejectAllHunks(merged)
console.log('Rejected:', rejected)
// Should equal content
```

---

### Step 1.3: Create the diffView directory structure

```bash
mkdir -p frontend/src/core/editor/codemirror/diffView
mkdir -p frontend/src/features/documents/utils
```

Create `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions
 */

// Extensions will be added in subsequent phases
// export { createDiffViewExtension } from './plugin'
```

---

## Verification Checklist

Before moving to Phase 2, verify:

- [ ] `mergedDocument.ts` created with all functions
- [ ] `buildMergedDocument()` correctly inserts markers
- [ ] `parseMergedDocument()` correctly extracts content/aiVersion
- [ ] `extractHunks()` returns correct positions
- [ ] `acceptAllHunks()` equals original aiVersion
- [ ] `rejectAllHunks()` equals original content
- [ ] `isInDeletionRegion()` correctly identifies DEL regions
- [ ] Directory structure created for diffView extension
- [ ] TypeScript compiles without errors

## Files Created

| File | Purpose |
|------|---------|
| `frontend/src/features/documents/utils/mergedDocument.ts` | Core utilities |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Extension entry point |

## Next Step

→ Continue to `02-decorations.md` to build the ViewPlugin that hides markers and styles regions.
