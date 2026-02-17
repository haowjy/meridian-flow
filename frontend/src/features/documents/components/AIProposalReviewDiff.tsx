import { useEffect, useRef } from "react";
import {
  mountProposalReviewMergeView,
  type ProposalReviewModel,
} from "@meridian/cm6-collab";

interface AIProposalReviewDiffProps {
  reviewModel: ProposalReviewModel | null;
}

export function AIProposalReviewDiff({
  reviewModel,
}: AIProposalReviewDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mergeViewRef = useRef<ReturnType<
    typeof mountProposalReviewMergeView
  > | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (reviewModel == null || reviewModel.availability === "unavailable") {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
      container.replaceChildren();
      return;
    }

    const config = {
      orientation: "a-b" as const,
      // Prose-first settings: show more context, collapse less aggressively
      // margin: lines of context around changes to show
      // minSize: minimum unchanged block size before collapsing
      collapseUnchanged: { margin: 4, minSize: 8 },
    };

    if (mergeViewRef.current == null) {
      mergeViewRef.current = mountProposalReviewMergeView({
        parent: container,
        baseText: reviewModel.baseText,
        proposedText: reviewModel.proposedText,
        config,
      });
      return;
    }

    mergeViewRef.current.update({
      baseText: reviewModel.baseText,
      proposedText: reviewModel.proposedText,
      config,
    });
  }, [reviewModel]);

  useEffect(() => {
    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
  }, []);

  if (reviewModel == null) {
    return (
      <div className="text-muted-foreground flex h-full min-h-44 items-center justify-center p-4 text-sm">
        Select a proposal to review.
      </div>
    );
  }

  if (reviewModel.availability === "unavailable") {
    return (
      <div className="flex h-full min-h-44 flex-col justify-center gap-2 p-4">
        <p className="text-sm font-medium">Diff unavailable</p>
        <p className="text-muted-foreground text-sm">{reviewModel.message}</p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full min-h-44 overflow-auto" />;
}
