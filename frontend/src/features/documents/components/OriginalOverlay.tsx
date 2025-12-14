/**
 * OriginalOverlay Component
 *
 * Read-only overlay showing the original content before AI changes.
 * Displayed over the main editor when in "Original" mode.
 *
 * Why an overlay instead of reconfiguring the main editor?
 * - The main editor contains the AI draft with edits
 * - Swapping content would lose cursor position and undo history
 * - Keeping main editor mounted preserves state when switching back
 *
 * SOLID:
 * - SRP: Only handles read-only original content display
 *
 * @see `_docs/plans/ai-editing/inline-suggestions.md` for full UX spec
 */

import { CodeMirrorEditor } from '@/core/editor/codemirror'

// ============================================================================
// COMPONENT
// ============================================================================

interface OriginalOverlayProps {
  /** The original content to display (before AI changes) */
  content: string
}

/**
 * Read-only overlay showing the original content.
 * Covers the main editor completely but keeps it mounted underneath.
 */
export function OriginalOverlay({ content }: OriginalOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 bg-background overflow-auto">
      <div className="relative pt-1 flex-1">
        <CodeMirrorEditor
          initialContent={content}
          editable={false}
          className="min-h-full"
        />
      </div>
    </div>
  )
}
