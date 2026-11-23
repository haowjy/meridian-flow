/**
 * ReviewStepper — `‹ 2 of 6 ›`: steps through the changes in document order, bringing each into
 * view. Before any change is focused it reads the count. `short` is a narrow pane's `2/6`; `touch`
 * makes both arrows 44px targets. The group takes the focus when Review changes opens.
 */
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
  short = false,
  crosses = false,
}: {
  count: number;
  /** The focused change's place, or -1 when none is focused. */
  focusedIndex: number;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
  touch?: boolean;
  short?: boolean;
  /** A step past either end goes on to another chapter: the stepper shows even for one change. */
  crosses?: boolean;
}) {
  if (count <= 1 && !crosses) return null;
  const position = focusedIndex + 1;
  return (
    <fieldset
      data-review-stepper
      aria-label={t`Changes in this chapter`}
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
          "whitespace-nowrap px-1 text-center text-xs text-muted-foreground tabular-nums",
          touch && "text-sm",
        )}
        aria-live="polite"
      >
        {focusedIndex >= 0 ? (
          short ? (
            `${position}/${count}`
          ) : (
            <Trans>
              {position} of {count}
            </Trans>
          )
        ) : short ? (
          count
        ) : count === 1 ? (
          <Trans>1 change</Trans>
        ) : (
          <Trans>{count} changes</Trans>
        )}
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
