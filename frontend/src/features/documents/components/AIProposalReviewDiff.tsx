import { useEffect, useLayoutEffect, useRef } from "react";
import {
  mountUnifiedReviewView,
  mountSplitReviewView,
  type ProposalOperationsModel,
} from "@meridian/cm6-collab";

// Duck-typed handle — both UnifiedReviewHandle and SplitReviewHandle expose
// the same update/destroy surface, so we avoid importing a shared interface
// from the package (which would require adding one).
interface ReviewHandle {
  update(params: {
    baseText: string;
    proposedText: string;
    chunks: Parameters<typeof mountUnifiedReviewView>[0]["chunks"];
  }): void;
  destroy(): void;
}

interface AIProposalReviewDiffProps {
  operationsModel: ProposalOperationsModel | null;
  mode: "unified" | "split";
  onAcceptChunk: (chunkId: string) => void;
  onRejectChunk: (chunkId: string) => void;
}

/**
 * Build a stable key from the model's meaningful identity so we can skip CM6
 * view recreation when nothing has actually changed (just new object refs).
 * Includes chunk IDs + text lengths to detect baseText/proposedText changes
 * even when chunk IDs remain stable.
 */
function modelKey(model: ProposalOperationsModel | null): string {
  if (model == null || model.availability !== "ready") return "";
  return `${model.chunks.map((c) => c.id).join(",")}|${model.baseText.length}|${model.proposedText.length}`;
}

export function AIProposalReviewDiff({
  operationsModel,
  mode,
  onAcceptChunk,
  onRejectChunk,
}: AIProposalReviewDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reviewViewRef = useRef<ReviewHandle | null>(null);
  // Track which mode is currently mounted so we can detect mode changes.
  const mountedModeRef = useRef<"unified" | "split" | null>(null);

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
      mountedModeRef.current = null;
      if (container) container.replaceChildren();
      return;
    }

    if (!container) return;

    const { baseText, proposedText, chunks } = operationsModel;

    if (chunks.length === 0) {
      reviewViewRef.current?.destroy();
      reviewViewRef.current = null;
      mountedModeRef.current = null;
      container.replaceChildren();
      return;
    }

    // If the mode changed, destroy the current view before remounting.
    if (reviewViewRef.current != null && mountedModeRef.current !== mode) {
      reviewViewRef.current.destroy();
      reviewViewRef.current = null;
      mountedModeRef.current = null;
      container.replaceChildren();
    }

    if (reviewViewRef.current == null) {
      if (mode === "split") {
        reviewViewRef.current = mountSplitReviewView({
          parent: container,
          baseText,
          proposedText,
          chunks,
          onAcceptChunk: (chunkId) => onAcceptChunkRef.current(chunkId),
          onRejectChunk: (chunkId) => onRejectChunkRef.current(chunkId),
        });
      } else {
        reviewViewRef.current = mountUnifiedReviewView({
          parent: container,
          baseText,
          proposedText,
          chunks,
          onAcceptChunk: (chunkId) => onAcceptChunkRef.current(chunkId),
          onRejectChunk: (chunkId) => onRejectChunkRef.current(chunkId),
        });
      }
      mountedModeRef.current = mode;
      return;
    }

    reviewViewRef.current.update({ baseText, proposedText, chunks });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modelKey provides stable identity; mode triggers remount
  }, [operationsModel?.availability, modelKey(operationsModel), mode]);

  useEffect(() => {
    return () => {
      reviewViewRef.current?.destroy();
      reviewViewRef.current = null;
      mountedModeRef.current = null;
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
          <p className="text-muted-foreground text-sm">
            {operationsModel.message}
          </p>
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
