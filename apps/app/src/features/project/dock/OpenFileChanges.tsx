/**
 * OpenFileChanges — the open file's body under its heading in `ReviewFiles`: its
 * changes in document order, or the state that stands in for them (loading,
 * Applying or Discarding the last change, "No changes left" with the way on,
 * formatting-only). The dock's Changes tab and the phone's changes sheet both
 * render it, so the file's state reads the same in either list; the rows
 * themselves are `DocumentChangeRows`. `touch` raises the rows and buttons to 44px.
 */
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import type { ReviewFileTarget } from "@/features/draft-review/review-files";
import type { DraftReviewController } from "@/features/draft-review/useDraftReviewController";
import type { ReviewChangesView } from "@/features/draft-review/useReviewChanges";

export function OpenFileChanges({
  view,
  controller,
  next,
  onOpenNext,
  touch = false,
  onFocused,
}: {
  view: ReviewChangesView;
  controller: Pick<DraftReviewController, "exitInlineReview">;
  next: ReviewFileTarget | null;
  onOpenNext: (row: ReviewFileTarget) => void;
  /** The phone's rows: every control a 44px target. */
  touch?: boolean;
  /** A change was tapped and focused in the manuscript (the phone closes its sheet). */
  onFocused?: () => void;
}) {
  const stateLine = () => {
    if (view.completing) return <ReviewCompleting mode={view.completing} />;
    if (view.finished) {
      return (
        <ReviewDone
          next={next}
          onOpenNext={onOpenNext}
          onBack={controller.exitInlineReview}
          touch={touch}
        />
      );
    }
    if (view.unlisted) {
      return (
        <p className="px-2 py-2 text-caption text-muted-foreground" role="status">
          <Trans>Formatting changes remain. Apply draft or Discard draft finishes them.</Trans>
        </p>
      );
    }
    return null;
  };

  return (
    <DocumentChangeRows
      view={view}
      touch={touch}
      standIn={view.status === "loading" ? null : stateLine()}
      onSelect={(change) => {
        onFocused?.();
        view.focus(change, { scroll: true });
      }}
    />
  );
}

/** The last change's command is in flight: what the writer did shows, and nothing says it is finished. */
function ReviewCompleting({ mode }: { mode: "apply" | "discard" }) {
  return (
    <p
      className="flex items-center gap-2 px-2 py-2 text-caption text-muted-foreground"
      role="status"
      aria-busy
    >
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {mode === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}
    </p>
  );
}

function ReviewDone({
  next,
  onOpenNext,
  onBack,
  touch,
}: {
  next: ReviewFileTarget | null;
  onOpenNext: (row: ReviewFileTarget) => void;
  onBack: () => void;
  touch: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-2">
      <p className="text-caption text-muted-foreground">
        <Trans>No changes left</Trans>
      </p>
      {next ? (
        <Button
          size={touch ? "default" : "xs"}
          className={touch ? "min-h-11" : undefined}
          onClick={() => onOpenNext(next)}
        >
          <Trans>Next draft</Trans>
        </Button>
      ) : (
        <Button
          size={touch ? "default" : "xs"}
          className={touch ? "min-h-11" : undefined}
          variant="outline"
          onClick={onBack}
        >
          <Trans>Back to live</Trans>
        </Button>
      )}
    </div>
  );
}
