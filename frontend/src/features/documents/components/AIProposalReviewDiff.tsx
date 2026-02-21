import { useEffect, useLayoutEffect, useRef } from "react";
import {
  mountUnifiedReviewView,
  type ProposalOperationsModel,
  type UnifiedReviewHandle,
} from "@meridian/cm6-collab";

interface AIProposalReviewDiffProps {
  operationsModel: ProposalOperationsModel | null;
  onAcceptChunk: (chunkId: string) => void;
  onRejectChunk: (chunkId: string) => void;
}

/**
 * Build a stable key from chunk IDs so we can skip CM6 view recreation
 * when the chunks haven't meaningfully changed (just new array references).
 */
function chunksKey(model: ProposalOperationsModel | null): string {
  if (model == null || model.availability !== "ready") return "";
  return model.chunks.map((c) => c.id).join(",");
}

export function AIProposalReviewDiff({
  operationsModel,
  onAcceptChunk,
  onRejectChunk,
}: AIProposalReviewDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reviewViewRef = useRef<UnifiedReviewHandle | null>(null);

  // Stable refs so the CM6 view callbacks don't capture stale closures.
  const onAcceptChunkRef = useRef(onAcceptChunk);
  const onRejectChunkRef = useRef(onRejectChunk);
  // Update refs after every render but before paint (useLayoutEffect), so CM6
  // callbacks always see the latest prop values without requiring view recreation.
  useLayoutEffect(() => {
    onAcceptChunkRef.current = onAcceptChunk;
    onRejectChunkRef.current = onRejectChunk;
  });

  useEffect(() => {
    const container = containerRef.current;

    // Always clean up if operationsModel is not ready
    if (operationsModel == null || operationsModel.availability !== "ready") {
      reviewViewRef.current?.destroy();
      reviewViewRef.current = null;
      if (container) container.replaceChildren();
      return;
    }

    if (!container) return;

    const { baseText, proposedText, chunks } = operationsModel;

    if (chunks.length === 0) {
      reviewViewRef.current?.destroy();
      reviewViewRef.current = null;
      container.replaceChildren();
      return;
    }

    if (reviewViewRef.current == null) {
      reviewViewRef.current = mountUnifiedReviewView({
        parent: container,
        baseText,
        proposedText,
        chunks,
        onAcceptChunk: (chunkId) => onAcceptChunkRef.current(chunkId),
        onRejectChunk: (chunkId) => onRejectChunkRef.current(chunkId),
      });
      return;
    }

    reviewViewRef.current.update({ baseText, proposedText, chunks });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chunksKey provides stable identity
  }, [operationsModel?.availability, chunksKey(operationsModel)]);

  useEffect(() => {
    return () => {
      reviewViewRef.current?.destroy();
      reviewViewRef.current = null;
    };
  }, []);

  if (operationsModel == null) {
    return (
      <div className="text-muted-foreground flex h-full min-h-44 items-center justify-center p-4 text-sm">
        Select a proposal to review.
      </div>
    );
  }

  if (operationsModel.availability === "unavailable") {
    return (
      <>
        {/* Keep container mounted so cleanup effect can find it */}
        <div ref={containerRef} className="hidden" />
        <div className="flex h-full min-h-44 flex-col justify-center gap-2 p-4">
          <p className="text-sm font-medium">Diff unavailable</p>
          <p className="text-muted-foreground text-sm">{operationsModel.message}</p>
        </div>
      </>
    );
  }

  if (operationsModel.chunks.length === 0) {
    return (
      <>
        <div ref={containerRef} className="hidden" />
        <div className="text-muted-foreground flex h-full min-h-44 items-center justify-center p-4 text-sm">
          No changes detected.
        </div>
      </>
    );
  }

  return <div ref={containerRef} className="h-full min-h-44 overflow-auto" />;
}
