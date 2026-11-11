/**
 * Focused change attribution and Apply/Discard, one control row on desktop and
 * phone. The bar is the one home of its draft's failure while it shows
 * (`useReviewFailures`). Where the bar's growth moves nothing (the margin, the
 * phone's bottom bar) the failure grows below the row. In the manuscript's flow
 * it would push the text down, so there it takes the byline's place in a row
 * tall enough for two lines.
 */
import { t } from "@lingui/core/macro";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { cn } from "@/lib/utils";
import { useDraftCommandState } from "./draft-changes";
import { ReviewActions } from "./ReviewActions";
import { ChangeAuthor } from "./ReviewChangeParts";
import { ReviewMessageText } from "./ReviewMessageText";
import type { BranchCommandFailure } from "./review-command-types";
import type { ReviewChange } from "./review-model";

export type ReviewChangeBarProps = {
  change: ReviewChange;
  itemKey: string;
  disabled: boolean;

  draftFailure?: BranchCommandFailure | null;
  /** False withdraws Apply (another document holds the path); Discard still applies. */
  canApply?: boolean;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
  /** Drawn in the manuscript's flow, after the change's paragraph. */
  inFlow?: boolean;
  className?: string;
};

export function ReviewChangeBar({
  change,
  itemKey,
  disabled,

  draftFailure,
  canApply = true,
  onApply,
  onDiscard,
  touch = false,
  inFlow = false,
  className,
}: ReviewChangeBarProps) {
  const owner = useDraftCommandOwner();
  const state = useDraftCommandState(itemKey);
  const failure = draftFailure ? (
    <InlineErrorRow
      message={<ReviewMessageText failure={draftFailure} />}
      onRetry={
        draftFailure.code === "unapply-refused" && state.stalled
          ? () => owner.retry(itemKey)
          : undefined
      }
      className="min-w-0 py-0 pr-2 pl-0"
    />
  ) : null;
  const failureInRow = inFlow && failure;
  return (
    <section
      aria-label={t`Change`}
      data-review-change-bar={change.id}
      className={cn(
        touch
          ? "flex flex-col items-stretch gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2.5 text-caption shadow-float"
          : "flex w-full max-w-full flex-col items-stretch gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2 text-caption shadow-float",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 shrink-0 items-center",
          touch ? "gap-3 py-0.5" : "gap-x-1.5",
          // Two lines of failure fit without growing the bar.
          inFlow && !touch && "min-h-7",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center">
          {failureInRow || (
            <ChangeAuthor
              touch={touch}
              fit="names"
              change={change}
              className={touch ? "min-h-11" : undefined}
            />
          )}
        </div>
        {!disabled ? (
          <ReviewActions
            scope="change"
            touch={touch}
            discardAsks={Boolean(change.tree)}
            onDiscard={onDiscard}
            onApply={canApply ? onApply : undefined}
          />
        ) : null}
      </div>
      {failureInRow ? null : failure}
    </section>
  );
}
