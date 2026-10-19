/**
 * DocumentChangeRows — one draft's changes as rows, from any `DraftChangesView`:
 * the open review's (`useReviewChanges`) or an unopened draft's
 * (`useDraftView`). Loading shows a skeleton, an unreadable room shows
 * Retry (never "no changes"), a ready draft shows its rows in document order
 * and pulses a change that arrived while the writer was looking.
 *
 * Presentational: the rows never decide what a click means. `onSelect` is the
 * caller's (focus the change in the manuscript, or open the draft's review at
 * it). `standIn` is a state line (Applying, No changes left) that replaces the
 * rows while this stays mounted, so a change that arrives meanwhile still pulses
 * when the rows return. `touch` raises the rows and buttons to 44px.
 */
import { t } from "@lingui/core/macro";
import { type ReactNode, useMemo } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Skeleton } from "@/components/ui/skeleton";
import { type DraftChangesView, isWholeDocumentChange } from "./draft-changes";
import { ReviewChangeRow } from "./ReviewChangeRow";
import type { ReviewChange } from "./review-model";
import { useArrivedChanges } from "./useArrivedChanges";

export function DocumentChangeRows({
  view,
  onSelect,
  standIn = null,
  touch = false,
  showAttribution = false,
  documentName,
}: {
  view: DraftChangesView;
  onSelect: (change: ReviewChange) => void;
  standIn?: ReactNode;
  touch?: boolean;
  showAttribution?: boolean;
  /** Catalog name when these rows stand in for a listed file's header. */
  documentName?: string;
}) {
  const wholeDocument = isWholeDocumentChange(view);
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.itemKey ? `${view.documentId}:${view.itemKey}` : null,
  );

  if (standIn) return standIn;
  if (view.status === "loading") {
    return (
      <div className="flex flex-col gap-1.5 px-2 py-1" aria-busy>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }
  if (view.status === "error") {
    return (
      <InlineErrorRow
        message={t`Changes couldn’t load`}
        onRetry={view.retry}
        actionLabel={t`Retry changes`}
      />
    );
  }
  return (
    <ul className="@container/changes flex flex-col gap-0.5">
      {view.items.map(({ change, failure, draftFailure }) => (
        <ReviewChangeRow
          touch={touch}
          wholeDocument={wholeDocument}
          documentName={wholeDocument ? documentName : undefined}
          showAttribution={showAttribution}
          key={change.id}
          change={change}
          focused={view.focused?.id === change.id}
          arrived={arrived.has(change.id)}
          disabled={view.locked}
          canApply={view.canApply}
          failure={failure}
          draftFailure={draftFailure}
          onFocus={() => onSelect(change)}
          onApply={() => void view.apply(change)}
          onDiscard={() => void view.discard(change)}
        />
      ))}
    </ul>
  );
}
