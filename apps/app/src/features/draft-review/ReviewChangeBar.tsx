/**
 * Focused change attribution and Apply/Discard, one control row on desktop and
 * phone. The bar is the one home of its draft's failure while it shows
 * (`useReviewFailures`). Where the bar's growth moves nothing (the margin, the
 * phone's bottom bar) the failure grows below the row. In the manuscript's flow
 * it would push the text down, so there it takes the byline's place in a row
 * tall enough for two lines.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChangeAuthor, discardLabel } from "./ReviewChangeParts";
import { ReviewMessageText } from "./ReviewMessageText";
import type { BranchCommandFailure } from "./review-command-types";
import type { ReviewChange } from "./review-model";

export type ReviewChangeBarProps = {
  change: ReviewChange;
  disabled: boolean;

  draftFailure?: BranchCommandFailure | null;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
  /** Drawn in the manuscript's flow, after the change's paragraph. */
  inFlow?: boolean;
  className?: string;
};

export function ReviewChangeBar({
  change,
  disabled,

  draftFailure,
  onApply,
  onDiscard,
  touch = false,
  inFlow = false,
  className,
}: ReviewChangeBarProps) {
  const label = discardLabel();
  const failure = draftFailure ? (
    <p role="status" className="min-w-0 break-words pr-2 text-meta text-destructive">
      <ReviewMessageText failure={draftFailure} />
    </p>
  ) : null;
  const failureInRow = inFlow && failure;
  return (
    <section
      aria-label={t`Change`}
      data-review-change-bar={change.id}
      className={cn(
        touch
          ? "flex flex-col items-stretch gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2.5 text-caption shadow-card"
          : "flex w-full max-w-full flex-col items-stretch gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2 text-caption shadow-card",
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
          <span
            className={
              touch
                ? "flex shrink-0 items-center gap-3"
                : "ml-auto flex items-center gap-1.5 whitespace-nowrap"
            }
          >
            <Button
              variant="quiet"
              size="xs"
              className={touch ? "h-11 px-4 text-sm" : undefined}
              aria-label={touch ? label : undefined}
              disabled={disabled}
              onClick={onDiscard}
            >
              {touch ? <Trans>Discard</Trans> : label}
            </Button>
            <Button
              size="xs"
              className={touch ? "h-11 min-w-20 px-5 text-sm" : undefined}
              disabled={disabled}
              onClick={onApply}
            >
              <Trans>Apply</Trans>
            </Button>
          </span>
        ) : null}
      </div>
      {failureInRow ? null : failure}
    </section>
  );
}
