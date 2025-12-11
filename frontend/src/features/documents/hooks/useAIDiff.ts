import { useMemo } from 'react'
import DiffMatchPatch from 'diff-match-patch'

// Diff operation types from diff-match-patch
const DIFF_DELETE = -1
const DIFF_INSERT = 1
const DIFF_EQUAL = 0

/**
 * Represents a single diff hunk between user content and AI suggestion.
 */
export interface DiffHunk {
  /** Content-based hash for stable React keys */
  id: string
  /** Character position in user content (for applying changes) */
  startPos: number
  /** Corresponding character position in AI version (for reverting) */
  aiStartPos: number
  /** Current user text (being replaced) */
  userText: string
  /** AI suggested text */
  aiText: string
}

// Simple hash function for stable hunk IDs
function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36)
}

// Singleton instance with configuration
const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 1  // 1 second max for large documents

/**
 * Computes diff hunks between user content and AI version.
 * Each hunk contains positions in both strings for bidirectional operations:
 * - Accept: replace userText with aiText at startPos in content
 * - Reject: replace aiText with userText at aiStartPos in ai_version
 */
function computeDiffHunks(userContent: string, aiVersion: string): DiffHunk[] {
  // Compute diff with semantic cleanup
  const diffs = dmp.diff_main(userContent, aiVersion)
  dmp.diff_cleanupSemantic(diffs)  // Merge small edits into meaningful chunks

  const hunks: DiffHunk[] = []
  let userPos = 0
  let aiPos = 0

  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i]
    if (!diff) continue
    const [op, text] = diff

    if (op === DIFF_EQUAL) {
      // Unchanged text - track positions in both strings
      userPos += text.length
      aiPos += text.length
      continue
    }

    // Found a change - collect consecutive DELETE/INSERT pairs
    let userText = ''
    let aiText = ''
    const startPos = userPos
    const aiStartPos = aiPos

    // Collect all consecutive changes
    while (i < diffs.length) {
      const currentDiff = diffs[i]
      if (!currentDiff || currentDiff[0] === DIFF_EQUAL) break
      const [currentOp, currentText] = currentDiff
      if (currentOp === DIFF_DELETE) {
        userText += currentText
        userPos += currentText.length
      } else if (currentOp === DIFF_INSERT) {
        aiText += currentText
        aiPos += currentText.length
      }
      i++
    }
    i-- // Adjust for loop increment

    // Use content-based hash for stable IDs across re-renders
    hunks.push({
      id: `hunk-${hashCode(userText + '|' + aiText)}`,
      startPos,
      aiStartPos,
      userText,
      aiText,
    })
  }

  return hunks
}

/**
 * Hook for computing live diffs between user content and AI suggestions.
 *
 * @param content - Current user content (from editor)
 * @param aiVersion - AI's suggested version (from document.aiVersion)
 * @returns Array of diff hunks, empty if no aiVersion
 *
 * @example
 * ```tsx
 * const hunks = useAIDiff(editorContent, document.aiVersion)
 *
 * // Accept hunk: apply AI change to content
 * const handleAccept = (hunk: DiffHunk) => {
 *   editor.replaceRange(hunk.startPos, hunk.startPos + hunk.userText.length, hunk.aiText)
 * }
 *
 * // Reject hunk: revert change in ai_version
 * const handleReject = async (hunk: DiffHunk) => {
 *   const newAIVersion = aiVersion.slice(0, hunk.aiStartPos) +
 *                        hunk.userText +
 *                        aiVersion.slice(hunk.aiStartPos + hunk.aiText.length)
 *   await api.documents.patchAIVersion(docId, newAIVersion)
 * }
 * ```
 */
export function useAIDiff(content: string, aiVersion: string | null | undefined): DiffHunk[] {
  return useMemo(() => {
    if (!aiVersion) return []
    if (content === aiVersion) return []  // No diff if identical
    return computeDiffHunks(content, aiVersion)
  }, [content, aiVersion])
}

/**
 * Apply an "Accept" operation: replace userText with aiText in content.
 * Returns the new content string.
 */
export function applyAccept(content: string, hunk: DiffHunk): string {
  return (
    content.slice(0, hunk.startPos) +
    hunk.aiText +
    content.slice(hunk.startPos + hunk.userText.length)
  )
}

/**
 * Apply a "Reject" operation: replace aiText with userText in ai_version.
 * Returns the new ai_version string.
 */
export function applyReject(aiVersion: string, hunk: DiffHunk): string {
  return (
    aiVersion.slice(0, hunk.aiStartPos) +
    hunk.userText +
    aiVersion.slice(hunk.aiStartPos + hunk.aiText.length)
  )
}
