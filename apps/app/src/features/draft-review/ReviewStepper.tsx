import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export function ReviewStepper({
  count,
  focusedIndex,
  disabled,
  onStep,
  touch = false,
  crosses = false,
}: {
  count: number;
  focusedIndex: number;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
  touch?: boolean;
  crosses?: boolean;
}) {
  if (count <= 1 && !crosses) return null;
  const position = focusedIndex + 1;
  return (
    <fieldset
      data-review-stepper
      aria-label={crosses ? t`Changes in this draft` : t`Changes in this chapter`}
      tabIndex={-1}
      className="focus-ring m-0 flex min-w-0 items-center gap-0.5 rounded-sm border-0 p-0"
    >
      <IconButton
        size="xs"
        variant="quiet"
        label={t`Previous change`}
        disabled={disabled}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft aria-hidden />
      </IconButton>
      <span
        className={cn(
          "review-step-count whitespace-nowrap px-1 text-center text-xs text-muted-foreground tabular-nums",
          touch && "text-sm",
        )}
        aria-live="polite"
      >
        <span className="review-count-long">
          {focusedIndex >= 0 ? (
            <Trans>
              {position} of {count}
            </Trans>
          ) : count === 1 ? (
            <Trans>1 change</Trans>
          ) : (
            <Trans>{count} changes</Trans>
          )}
        </span>
        <span aria-hidden className="review-count-short hidden">
          {focusedIndex >= 0 ? `${position}/${count}` : count}
        </span>
      </span>
      <IconButton
        size="xs"
        variant="quiet"
        label={t`Next change`}
        disabled={disabled}
        onClick={() => onStep(1)}
      >
        <ChevronRight aria-hidden />
      </IconButton>
    </fieldset>
  );
}
