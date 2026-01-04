/**
 * Floating Navigation Pill for AI Suggestions
 *
 * SRP: Navigation UI only. Doesn't manage state or dispatch transactions.
 * Parent component (EditorPanel) handles state and wires up callbacks.
 *
 * Positioned at bottom-center of the editor container.
 * Shows: change counter, prev/next nav, reject/accept all buttons.
 */

import { ChevronUp, ChevronDown } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import type { MergedHunk } from '@/core/lib/mergedDocument'

// =============================================================================
// TYPES
// =============================================================================

interface AIHunkNavigatorProps {
  /** All hunks in the document */
  hunks: MergedHunk[]
  /** Currently focused hunk index (0-based) */
  currentIndex: number
  /** Navigate to previous hunk */
  onPrevious: () => void
  /** Navigate to next hunk */
  onNext: () => void
  /** Accept all changes (dispatches CM6 transaction) */
  onAcceptAll: () => void
  /** Reject all changes (dispatches CM6 transaction) */
  onRejectAll: () => void
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Floating navigation pill for diff hunks.
 *
 * Usage:
 * ```tsx
 * <div className="relative">
 *   <CodeMirrorEditor ... />
 *   <AIHunkNavigator
 *     hunks={hunks}
 *     currentIndex={focusedHunkIndex}
 *     onPrevious={() => navigateHunk('prev', hunks.length)}
 *     onNext={() => navigateHunk('next', hunks.length)}
 *     onAcceptAll={() => acceptAll(editorView)}
 *     onRejectAll={() => rejectAll(editorView)}
 *   />
 * </div>
 * ```
 */
export function AIHunkNavigator({
  hunks,
  currentIndex,
  onPrevious,
  onNext,
  onAcceptAll,
  onRejectAll,
}: AIHunkNavigatorProps) {
  // Don't render if no hunks (no AI changes)
  if (hunks.length === 0) return null

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div
        className="flex items-center gap-1 bg-background/95 backdrop-blur
                   border rounded-lg px-2 py-0.5 shadow-lg pointer-events-auto"
      >
        {/* Navigation controls */}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onPrevious}
          title="Previous change"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>

        {/* Change counter */}
        <span className="text-sm text-muted-foreground min-w-[5rem] text-center tabular-nums">
          Change {currentIndex + 1} / {hunks.length}
        </span>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onNext}
          title="Next change"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>

        {/* Separator */}
        <div className="w-px h-5 bg-border mx-1" />

        {/* Bulk actions */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs px-2 text-red-600/70 hover:text-red-700 hover:bg-red-50"
          onClick={onRejectAll}
          title="Reject all changes"
        >
          Reject All
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs px-2 text-green-600/70 hover:text-green-700 hover:bg-green-50"
          onClick={onAcceptAll}
          title="Accept all changes"
        >
          Accept All
        </Button>
      </div>
    </div>
  )
}
