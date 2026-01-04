/**
 * Merged Document Utilities
 *
 * Transforms between storage format (separate content/aiVersion) and
 * editor format (merged document with PUA markers).
 *
 * The merged document embeds both versions with Unicode Private Use Area
 * markers, enabling CM6 history to track accept/reject as normal edits.
 */

import DiffMatchPatch from 'diff-match-patch'

// =============================================================================
// PUA MARKERS
// =============================================================================

/**
 * Unicode Private Use Area markers for diff regions.
 * These characters never appear in normal text, so no escaping needed.
 */
export const MARKERS = {
  DEL_START: '\uE000', // Start of deletion (original text)
  DEL_END: '\uE001', // End of deletion
  INS_START: '\uE002', // Start of insertion (AI text)
  INS_END: '\uE003', // End of insertion
} as const

/**
 * Regex to match a complete hunk (DEL followed by INS).
 * Captures: [full match, deletion content, insertion content]
 *
 * INVARIANT: buildMergedDocument() always produces DEL-INS pairs:
 * - Pure deletion: empty INS (DEL_START + text + DEL_END + INS_START + INS_END)
 * - Pure insertion: empty DEL (DEL_START + DEL_END + INS_START + text + INS_END)
 * - Replacement: both have content
 *
 * This regex will NOT match orphaned markers or out-of-order markers.
 * Use validateMarkerStructure() to detect corruption before parsing.
 */
export const HUNK_REGEX = new RegExp(
  `${MARKERS.DEL_START}([^${MARKERS.DEL_END}]*)${MARKERS.DEL_END}` +
    `${MARKERS.INS_START}([^${MARKERS.INS_END}]*)${MARKERS.INS_END}`,
  'g'
)

/**
 * Regex to match any marker character.
 * Use for .test() checks - do NOT use with .replace() (use ALL_MARKER_REGEX).
 */
export const ANY_MARKER_REGEX = /[\uE000-\uE003]/

/**
 * Regex to match all marker characters (global).
 * Use for .replace() - do NOT use for .test() (lastIndex issues).
 */
export const ALL_MARKER_REGEX = /[\uE000-\uE003]/g

/**
 * Check if any PUA marker exists in the string.
 * NOTE: Empty string "" is valid content; markers, not falsy-ness, is the signal.
 */
export function hasAnyMarker(text: string): boolean {
  return ANY_MARKER_REGEX.test(text)
}

/**
 * Remove all marker characters from a string.
 * Used to sanitize inputs (server content/aiVersion, AI output, clipboard).
 */
export function stripMarkers(text: string): string {
  return text.replace(ALL_MARKER_REGEX, '')
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * A diff hunk in the merged document.
 * Used for decoration positioning and accept/reject operations.
 */
export interface MergedHunk {
  /** Unique ID for React keys (index-based) */
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
 * // Result contains PUA markers around "She felt sad." and "A heavy melancholia."
 * ```
 */
export function buildMergedDocument(
  content: string,
  aiVersion: string
): string {
  // Defensive: strip any accidental PUA markers from inputs.
  // If markers exist inside content, they would become structurally ambiguous.
  if (hasAnyMarker(content) || hasAnyMarker(aiVersion)) {
    console.warn(
      'buildMergedDocument: stripping unexpected PUA markers from inputs'
    )
    content = stripMarkers(content)
    aiVersion = stripMarkers(aiVersion)
  }

  // If identical, no markers needed
  if (content === aiVersion) {
    return content
  }

  // Compute character-level diff with semantic cleanup for readability.
  // - diff_cleanupSemantic: merge small edits into meaningful chunks
  // - diff_cleanupSemanticLossless: shift boundaries to word/whitespace edges
  const diffs = dmp.diff_main(content, aiVersion)
  dmp.diff_cleanupSemantic(diffs)
  dmp.diff_cleanupSemanticLossless(diffs)

  // Build merged document with markers
  const parts: string[] = []
  let i = 0

  while (i < diffs.length) {
    const diff = diffs[i]
    if (!diff) {
      i++
      continue
    }
    const [op, text] = diff

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
          MARKERS.DEL_START +
            text +
            MARKERS.DEL_END +
            MARKERS.INS_START +
            nextDiff[1] +
            MARKERS.INS_END
        )
        i += 2
      } else {
        // Pure deletion (no replacement) - empty INS
        parts.push(
          MARKERS.DEL_START +
            text +
            MARKERS.DEL_END +
            MARKERS.INS_START +
            MARKERS.INS_END
        )
        i++
      }
    } else if (op === 1) {
      // Pure insertion (no deletion) - empty DEL
      parts.push(
        MARKERS.DEL_START +
          MARKERS.DEL_END +
          MARKERS.INS_START +
          text +
          MARKERS.INS_END
      )
      i++
    }
  }

  return parts.join('')
}

// =============================================================================
// MARKER VALIDATION
// =============================================================================

/**
 * Error thrown when marker structure is corrupted.
 */
export class DiffMarkersCorruptedError extends Error {
  constructor(reason: string) {
    super(`Diff marker structure is corrupted: ${reason}`)
    this.name = 'DiffMarkersCorruptedError'
  }
}

/**
 * Validate that marker structure is well-formed.
 *
 * Valid structure: sequence of (DEL_START, text?, DEL_END, INS_START, text?, INS_END)
 * DEL_END must be immediately followed by INS_START (no text between them).
 *
 * @returns { ok: true } if valid, { ok: false, reason: string } if not
 */
export function validateMarkerStructure(
  merged: string
): { ok: true } | { ok: false; reason: string } {
  // State machine: 'outside' -> 'inDel' -> 'afterDel' -> 'inIns' -> 'outside'
  type State = 'outside' | 'inDel' | 'afterDel' | 'inIns'
  let state: State = 'outside'

  for (let i = 0; i < merged.length; i++) {
    const char = merged[i]

    // CRITICAL: DEL_END must be immediately followed by INS_START.
    // If anything else appears between them, hunk extraction breaks.
    if (state === 'afterDel' && char !== MARKERS.INS_START) {
      return {
        ok: false,
        reason: `Expected INS_START immediately after DEL_END (position ${i}), got ${JSON.stringify(char)}`,
      }
    }

    if (char === MARKERS.DEL_START) {
      if (state !== 'outside') {
        return {
          ok: false,
          reason: `Unexpected DEL_START at position ${i}, state was ${state}`,
        }
      }
      state = 'inDel'
    } else if (char === MARKERS.DEL_END) {
      if (state !== 'inDel') {
        return {
          ok: false,
          reason: `Unexpected DEL_END at position ${i}, state was ${state}`,
        }
      }
      state = 'afterDel'
    } else if (char === MARKERS.INS_START) {
      if (state !== 'afterDel') {
        return {
          ok: false,
          reason: `Unexpected INS_START at position ${i}, state was ${state}`,
        }
      }
      state = 'inIns'
    } else if (char === MARKERS.INS_END) {
      if (state !== 'inIns') {
        return {
          ok: false,
          reason: `Unexpected INS_END at position ${i}, state was ${state}`,
        }
      }
      state = 'outside'
    }
  }

  if (state !== 'outside') {
    return {
      ok: false,
      reason: `Unclosed marker structure, ended in state ${state}`,
    }
  }

  return { ok: true }
}

// =============================================================================
// PARSE MERGED DOCUMENT
// =============================================================================

/**
 * Parse a merged document back into content and aiVersion.
 *
 * @param merged - The merged document with PUA markers
 * @returns Parsed content and aiVersion (clean markdown, no markers)
 * @throws DiffMarkersCorruptedError if marker structure is invalid
 *
 * @example
 * ```typescript
 * const { content, aiVersion } = parseMergedDocument(merged)
 * // content: baseline with AI changes removed
 * // aiVersion: AI version with deletions removed, or null if no markers
 * ```
 */
export function parseMergedDocument(merged: string): ParsedDocument {
  // Check if any markers exist
  if (!hasAnyMarker(merged)) {
    // No markers = no AI changes (either never had them or all resolved)
    return {
      content: merged,
      aiVersion: null,
      hasChanges: false,
    }
  }

  // Validate structure before parsing to prevent corrupt markers leaking into output
  const validation = validateMarkerStructure(merged)
  if (!validation.ok) {
    throw new DiffMarkersCorruptedError(validation.reason)
  }

  // Build content: keep DEL content, remove INS regions entirely
  const content = merged
    // Remove INS regions entirely (including content)
    .replace(
      new RegExp(
        `${MARKERS.INS_START}[^${MARKERS.INS_END}]*${MARKERS.INS_END}`,
        'g'
      ),
      ''
    )
    // Keep DEL content but remove markers
    .replace(new RegExp(MARKERS.DEL_START, 'g'), '')
    .replace(new RegExp(MARKERS.DEL_END, 'g'), '')

  // Build aiVersion: keep INS content, remove DEL regions entirely
  const aiVersion = merged
    // Remove DEL regions entirely (including content)
    .replace(
      new RegExp(
        `${MARKERS.DEL_START}[^${MARKERS.DEL_END}]*${MARKERS.DEL_END}`,
        'g'
      ),
      ''
    )
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
 * IDs are index-based (hunk-0, hunk-1, etc.) because:
 * - IDs only used for React keys - we re-extract hunks on every doc change
 * - Stable during typing - positions shift but hunk count stays same
 * - Accept/reject uses from/to positions, not IDs
 * - No collision risk (unlike content hash with duplicate text)
 *
 * @param merged - The merged document with PUA markers
 * @returns Array of hunks with positions and content
 */
export function extractHunks(merged: string): MergedHunk[] {
  const hunks: MergedHunk[] = []

  // Reset regex state (important for global regex)
  HUNK_REGEX.lastIndex = 0

  let match: RegExpExecArray | null
  let index = 0
  while ((match = HUNK_REGEX.exec(merged)) !== null) {
    const fullMatch = match[0]
    // Captures are always defined for this regex (may be empty string, never undefined)
    const deletedText = match[1] ?? ''
    const insertedText = match[2] ?? ''

    const from = match.index
    const to = from + fullMatch.length

    // Calculate marker positions within the hunk
    // Positions are the START index of each marker character
    const delStart = from // Position of DEL_START marker (\uE000)
    const delEnd = from + 1 + deletedText.length // Position of DEL_END marker (\uE001)
    const insStart = delEnd + 1 // Position of INS_START marker (\uE002)
    const insEnd = to - 1 // Position of INS_END marker (\uE003)

    hunks.push({
      id: `hunk-${index}`,
      from,
      to,
      delStart,
      delEnd,
      insStart,
      insEnd,
      deletedText,
      insertedText,
    })
    index++
  }

  return hunks
}

// =============================================================================
// ACCEPT / REJECT OPERATIONS
// =============================================================================

/**
 * Get the replacement text for accepting a hunk.
 * Accept = keep AI text, remove original.
 *
 * @param hunk - The hunk to accept
 * @returns Text to insert (the insertion content without markers)
 */
export function getAcceptReplacement(hunk: MergedHunk): string {
  return hunk.insertedText
}

/**
 * Get the replacement text for rejecting a hunk.
 * Reject = keep original text, remove AI version.
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
  return merged.replace(HUNK_REGEX, (_match, del) => del)
}

// =============================================================================
// POSITION UTILITIES
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
