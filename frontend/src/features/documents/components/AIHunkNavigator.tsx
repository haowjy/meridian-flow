/**
 * Floating Navigation Pill for AI Suggestions
 *
 * SRP: Navigation UI only. Doesn't manage state or dispatch transactions.
 * Parent component (EditorPanel) handles state and wires up callbacks.
 *
 * Rendered inside a sticky bottom wrapper by EditorPanel, so it floats
 * at the bottom of the viewport while scrolling.
 * Shows: change counter, prev/next nav, reject/accept all buttons.
 */

import { ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import type { MergedHunk } from "@/core/lib/mergedDocument";

// =============================================================================
// TYPES
// =============================================================================

interface AIHunkNavigatorProps {
  /** All hunks in the document */
  hunks: MergedHunk[];
  /** Currently focused hunk index (0-based) */
  currentIndex: number;
  /** Navigate to previous hunk */
  onPrevious: () => void;
  /** Navigate to next hunk */
  onNext: () => void;
  /** Accept all changes (dispatches CM6 transaction) */
  onAcceptAll: () => void;
  /** Reject all changes (dispatches CM6 transaction) */
  onRejectAll: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Floating navigation pill for diff hunks.
 *
 * Usage (rendered inside a sticky wrapper at end of scroll container):
 * ```tsx
 * <div className="overflow-y-auto">
 *   <CodeMirrorEditor ... />
 *   {hasAISuggestions && (
 *     <div className="sticky bottom-0 pointer-events-none">
 *       <AIHunkNavigator hunks={hunks} currentIndex={idx} ... />
 *     </div>
 *   )}
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
  if (hunks.length === 0) return null;

  return (
    <div className="pointer-events-none flex justify-center pb-4">
      <div className="bg-background/95 pointer-events-auto flex items-center gap-1 rounded-lg border px-2 py-0.5 shadow-lg backdrop-blur">
        {/* Navigation controls */}
        <Button
          size="icon"
          variant="ghost"
          onClick={onPrevious}
          title="Previous change"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>

        {/* Change counter */}
        <span className="text-muted-foreground min-w-[5rem] text-center text-sm tabular-nums">
          Change {currentIndex + 1} / {hunks.length}
        </span>

        <Button
          size="icon"
          variant="ghost"
          onClick={onNext}
          title="Next change"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>

        {/* Separator */}
        <div className="bg-border mx-1 h-5 w-px" />

        {/* Bulk actions */}
        <Button
          size="sm"
          variant="ghost"
          className="text-error/70 hover:text-error hover:bg-error/10 h-7 px-2 text-xs"
          onClick={onRejectAll}
          title="Reject all changes"
        >
          Reject All
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="text-success/70 hover:text-success hover:bg-success/10 h-7 px-2 text-xs"
          onClick={onAcceptAll}
          title="Accept all changes"
        >
          Accept All
        </Button>
      </div>
    </div>
  );
}
