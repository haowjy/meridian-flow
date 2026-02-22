/**
 * ProposalReviewToolbar — floating pill at the bottom-center of the editor
 * providing batch actions (keep/discard all) and hunk navigation for
 * proposal review.
 *
 * Writer-first language: "Keep All" / "Discard All" instead of
 * "Accept All" / "Reject All" — the writer is the author making creative
 * choices about their text, not a code reviewer gatekeeping changes.
 *
 * Only visible when there are pending review hunks. Entrance animation
 * (slide-up + fade) anchors the writer's attention when review starts.
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
  onKeepAll: () => void;
  onDiscardAll: () => void;
  onPrevHunk: () => void;
  onNextHunk: () => void;
}

export function ProposalReviewToolbar({
  totalHunks,
  activeHunkIndex,
  resolvedCount,
  onKeepAll,
  onDiscardAll,
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
      <div className="cm-review-toolbar-pill bg-surface border-border pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-1 shadow-lg">
        {/* Keep All */}
        <Button
          variant="accent"
          size="xs"
          onClick={onKeepAll}
          title="Keep all changes"
          className="bg-success/15 text-success hover:bg-success/25 rounded-full"
        >
          <Check className="size-3" />
          Keep All
        </Button>

        {/* Discard All */}
        <Button
          variant="ghost"
          size="xs"
          onClick={onDiscardAll}
          title="Discard all changes"
          className="text-error hover:bg-error/10 rounded-full"
        >
          <X className="size-3" />
          Discard All
        </Button>

        {/* Separator */}
        <div className="bg-border mx-0.5 h-4 w-px" />

        {/* Prev Hunk */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onPrevHunk}
          title="Previous hunk (Alt-[)"
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
          title="Next hunk (Alt-])"
          disabled={pendingCount <= 1}
          className="rounded-full"
        >
          <ChevronRight className="size-3" />
        </Button>
      </div>
    </div>
  );
}
