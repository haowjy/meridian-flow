/**
 * DocumentChanges — the open review's own change list: its changes in document
 * order, or the state that stands in for them (loading, Applying or Discarding
 * the last change, "No changes left" with the way on, formatting-only,
 * marks hidden). The identity row's list popover and the phone's change sheet
 * both render it, so the document's state reads the same in either; the rows
 * themselves are `DocumentChangeRows`. A row focuses its change in the
 * manuscript. `touch` raises the rows and buttons to 44px.
 */

import { t } from "@lingui/core/macro";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { DocumentChangeRows } from "./DocumentChangeRows";
import { ReviewNextAction, ReviewStatusContent } from "./ReviewCompletion";
import type { DraftReviewController } from "./useDraftReviewController";
import type { ReviewChangesView } from "./useReviewChanges";

/** The name of the button that opens the document's change list: the count when there is one. */
export function changeListLabel(count: number): string {
  if (count === 0) return t`Show the changes list`;
  return count === 1 ? t`Show the 1 change` : t`Show the ${count} changes`;
}

export function DocumentChanges({
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
    if (view.finished && !view.completing) {
      return (
        <div className="flex flex-col items-start gap-2 px-2 py-2" role="status">
          <p className="text-caption text-muted-foreground">
            <ReviewStatusContent finished />
          </p>
          <ReviewNextAction
            next={next}
            onOpenNext={onOpenNext}
            onShowLive={controller.exitInlineReview}
            size={touch ? "default" : "xs"}
            className={touch ? "min-h-11" : undefined}
          />
        </div>
      );
    }
    if (view.completing || view.unlisted) {
      return (
        <p
          className="flex items-center gap-2 px-2 py-2 text-caption text-muted-foreground"
          role="status"
          aria-busy={!!view.completing}
        >
          <ReviewStatusContent completing={view.completing} finished={false} explainFormatting />
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
