import { useEffect, useRef } from "react";
import { mountProposalReviewMergeView } from "@/core/cm6-collab";

interface SnapshotPreviewDiffProps {
  baseText: string;
  snapshotText: string;
}

export function SnapshotPreviewDiff({
  baseText,
  snapshotText,
}: SnapshotPreviewDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mergeViewRef = useRef<ReturnType<
    typeof mountProposalReviewMergeView
  > | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const config = {
      orientation: "a-b" as const,
      collapseUnchanged: { margin: 4, minSize: 8 },
    };

    if (mergeViewRef.current == null) {
      mergeViewRef.current = mountProposalReviewMergeView({
        parent: container,
        baseText,
        proposedText: snapshotText,
        config,
      });
      return;
    }

    mergeViewRef.current.update({
      baseText,
      proposedText: snapshotText,
      config,
    });
  }, [baseText, snapshotText]);

  useEffect(() => {
    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="h-full min-h-56 overflow-auto" />;
}
