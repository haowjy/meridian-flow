/**
 * OpenFileChanges — the open file's body under its heading in `ReviewFiles`: its
 * changes in document order, or the state that stands in for them (loading,
 * Applying or Discarding the last change, "No changes left" with the way on,
 * formatting-only). The dock's Changes tab and the phone's changes sheet both
 * render it, so the file's state reads the same in either list. `touch` raises
 * the rows and buttons to 44px.
 */
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { DockRow } from "@/features/chat/docked-drafts";
import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { ReviewChangeRow } from "@/features/draft-review/ReviewChangeRow";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
import type { useReviewChanges } from "@/features/draft-review/useReviewChanges";

export function OpenFileChanges({
  view,
  controller,
  next,
  onOpenNext,
  touch = false,
  onFocused,
}: {
  view: ReturnType<typeof useReviewChanges>;
  controller: Pick<DraftReviewController, "exitInlineReview">;
  next: DockRow | null;
  onOpenNext: (row: DockRow) => void;
  /** The phone's rows: every control a 44px target. */
  touch?: boolean;
  /** A change was tapped and focused in the manuscript (the phone closes its sheet). */
  onFocused?: () => void;
}) {
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.draftId ? `${view.documentId}:${view.draftId}` : null,
  );

  return view.status === "loading" ? (
    <div className="flex flex-col gap-1.5 px-2 py-1" aria-busy>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  ) : view.completing ? (
    <ReviewCompleting mode={view.completing} />
  ) : view.finished ? (
    <ReviewDone
      next={next}
      onOpenNext={onOpenNext}
      onBack={controller.exitInlineReview}
      touch={touch}
    />
  ) : view.unlisted ? (
    <p className="px-2 py-2 text-caption text-muted-foreground" role="status">
      <Trans>Formatting changes remain. Apply draft or Discard draft finishes them.</Trans>
    </p>
  ) : (
    <ul className="flex flex-col gap-0.5">
      {view.items.map(({ change, failure }) => (
        <ReviewChangeRow
          touch={touch}
          key={change.classId}
          change={change}
          focused={view.focused?.classId === change.classId}
          arrived={arrived.has(change.classId)}
          disabled={view.locked}
          canApply={view.canApply}
          failure={failure}
          onFocus={() => {
            onFocused?.();
            view.focus(change, { scroll: true });
          }}
          onApply={() => void view.apply(change)}
          onDiscard={() => void view.discard(change)}
        />
      ))}
    </ul>
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
  next: DockRow | null;
  onOpenNext: (row: DockRow) => void;
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
