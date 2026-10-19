/** The document's change rows, shared by the popover and phone sheet. Completion lives in the review header; the list closes after the last change. */
import { t } from "@lingui/core/macro";
import { DocumentChangeRows } from "./DocumentChangeRows";
import { ReviewStatusContent } from "./ReviewCompletion";
import type { ReviewChangesView } from "./useReviewChanges";

/** The name of the button that opens the document's change list: the count when there is one. */
export function changeListLabel(count: number): string {
  if (count === 0) return t`Show the changes list`;
  return count === 1 ? t`Show the 1 change` : t`Show the ${count} changes`;
}

export function DocumentChanges({
  view,
  touch = false,
  onFocused,
}: {
  view: ReviewChangesView;
  /** The phone's rows: every control a 44px target. */
  touch?: boolean;
  /** A change was tapped and focused in the manuscript (the phone closes its sheet). */
  onFocused?: () => void;
}) {
  const stateLine = () => {
    if (view.completing) {
      return (
        <p
          className="flex items-center gap-2 px-2 py-2 text-caption text-muted-foreground"
          role="status"
          aria-busy={!!view.completing}
        >
          <ReviewStatusContent completing={view.completing} finished={false} />
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
