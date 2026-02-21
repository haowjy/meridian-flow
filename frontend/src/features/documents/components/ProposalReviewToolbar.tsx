/**
 * ProposalReviewToolbar — floating pill at the bottom-center of the editor
 * providing batch actions (accept/reject all) and hunk navigation for
 * proposal review.
 *
 * Only visible when there are pending review hunks.
 */

import { Button } from "@/shared/components/ui/button";
import { Check, X, ChevronLeft, ChevronRight } from "lucide-react";

interface ProposalReviewToolbarProps {
  /** Total number of pending review hunks */
  totalHunks: number;
  /** Currently active hunk index (0-based, -1 = none) */
  activeHunkIndex: number;
  /** Number of hunks already resolved */
  resolvedCount: number;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onPrevHunk: () => void;
  onNextHunk: () => void;
}

export function ProposalReviewToolbar({
  totalHunks,
  activeHunkIndex,
  resolvedCount,
  onAcceptAll,
  onRejectAll,
  onPrevHunk,
  onNextHunk,
}: ProposalReviewToolbarProps) {
  const pendingCount = totalHunks - resolvedCount;

  // Don't render when there are no active review hunks
  if (pendingCount <= 0) return null;

  // Display 1-based position within pending hunks
  const displayIndex = activeHunkIndex >= 0 ? activeHunkIndex + 1 : 0;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <div className="bg-surface border-border pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-1 shadow-lg">
        {/* Accept All */}
        <Button
          variant="accent"
          size="xs"
          onClick={onAcceptAll}
          title="Accept all changes"
          className="bg-success/15 text-success hover:bg-success/25 rounded-full"
        >
          <Check className="size-3" />
          Accept All
        </Button>

        {/* Reject All */}
        <Button
          variant="ghost"
          size="xs"
          onClick={onRejectAll}
          title="Reject all changes"
          className="text-error hover:bg-error/10 rounded-full"
        >
          <X className="size-3" />
          Reject All
        </Button>

        {/* Separator */}
        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Prev Hunk */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onPrevHunk}
          title="Previous hunk (Ctrl-[)"
          disabled={pendingCount <= 1}
          className="rounded-full"
        >
          <ChevronLeft className="size-3" />
        </Button>

        {/* Hunk Counter */}
        <span className="text-muted-foreground min-w-[2.5rem] text-center text-xs tabular-nums">
          {displayIndex}/{pendingCount}
        </span>

        {/* Next Hunk */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNextHunk}
          title="Next hunk (Ctrl-])"
          disabled={pendingCount <= 1}
          className="rounded-full"
        >
          <ChevronRight className="size-3" />
        </Button>
      </div>
    </div>
  );
}
