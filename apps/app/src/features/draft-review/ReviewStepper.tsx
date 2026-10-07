/**
 * ReviewStepper — `‹ 2 of 6 ›`: steps through the changes in document order,
 * bringing each into view. Before any change is focused it reads the count, and
 * the first step lands on the first (or, going back, the last) change.
 * `touch` makes both arrows 44px targets for a phone.
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
}: {
  count: number;
  /** The focused change's place, or -1 when none is focused. */
  focusedIndex: number;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
  touch?: boolean;
}) {
  const position = focusedIndex + 1;
  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        size="xs"
        variant={touch ? "quiet" : "outline"}
        className={touch ? "size-11" : undefined}
        tooltip={t`Previous change`}
        disabled={disabled}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft aria-hidden className={touch ? "size-5" : undefined} />
      </IconButton>
      <span
        className={cn(
          "min-w-14 px-1 text-center text-caption text-muted-foreground tabular-nums",
          touch && "text-sm",
        )}
        aria-live="polite"
      >
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
      <IconButton
        size="xs"
        variant={touch ? "quiet" : "outline"}
        className={touch ? "size-11" : undefined}
        tooltip={t`Next change`}
        disabled={disabled}
        onClick={() => onStep(1)}
      >
        <ChevronRight aria-hidden className={touch ? "size-5" : undefined} />
      </IconButton>
    </div>
  );
}
