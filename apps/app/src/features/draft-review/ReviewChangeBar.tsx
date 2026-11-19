/**
 * Focused change attribution and Apply/Discard, one control row on desktop and
 * phone.
 */
import { t } from "@lingui/core/macro";
import { cn } from "@/lib/utils";
import { ReviewActions } from "./ReviewActions";
import { ChangeAuthor } from "./ReviewChangeParts";
import type { ReviewChange } from "./review-model";

export type ReviewChangeBarProps = {
  change: ReviewChange;
  disabled: boolean;
  /** False withdraws Apply (another document holds the path); Discard still applies. */
  canApply?: boolean;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
  className?: string;
};

export function ReviewChangeBar({
  change,
  disabled,
  canApply = true,
  onApply,
  onDiscard,
  touch = false,
  className,
}: ReviewChangeBarProps) {
  return (
    <section
      aria-label={t`Change`}
      data-review-change-bar={change.id}
      className={cn(
        touch
          ? "flex min-w-min flex-col items-stretch gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2.5 text-xs shadow-float"
          : "flex w-full min-w-min max-w-full flex-col items-stretch gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2 text-xs shadow-float",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 shrink-0 flex-wrap items-center gap-y-0.5",
          touch ? "gap-x-3 py-0.5" : "gap-x-1.5",
        )}
      >
        <div className="flex min-w-12 flex-1 items-center">
          <ChangeAuthor
            touch={touch}
            fit="names"
            change={change}
            className={touch ? "min-h-11" : undefined}
          />
        </div>
        {!disabled ? (
          <ReviewActions
            scope="change"
            touch={touch}
            onDiscard={onDiscard}
            onApply={canApply ? onApply : undefined}
            className="ml-auto"
          />
        ) : null}
      </div>
    </section>
  );
}
