/**
 * ReviewStepper — `‹ 2 of 6 ›`: steps through the changes in document order,
 * bringing each into view. Before any change is focused it reads the count, and
 * the first step lands on the first (or, going back, the last) change.
 * `touch` makes both arrows 44px targets for a phone. `compact` is the identity
 * row's form: 22px boxes, and `4/4` once the row's container gets narrow.
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
  compact = false,
}: {
  count: number;
  /** The focused change's place, or -1 when none is focused. */
  focusedIndex: number;
  disabled: boolean;
  onStep: (direction: 1 | -1) => void;
  touch?: boolean;
  compact?: boolean;
}) {
  const position = focusedIndex + 1;
  const arrow = touch ? "size-11" : compact ? "size-5.5" : undefined;
  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        size="xs"
        variant={touch || compact ? "quiet" : "outline"}
        className={arrow}
        tooltip={t`Previous change`}
        disabled={disabled}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft aria-hidden className={touch ? "size-5" : undefined} />
      </IconButton>
      <span
        className={cn(
          "px-1 text-center text-caption text-muted-foreground tabular-nums",
          compact ? "whitespace-nowrap" : "min-w-14",
          touch && "text-sm",
        )}
        aria-live="polite"
      >
        {focusedIndex >= 0 ? (
          compact ? (
            <>
              <span className="@max-[34rem]:sr-only">
                <Trans>
                  {position} of {count}
                </Trans>
              </span>
              <span aria-hidden className="hidden @max-[34rem]:inline">
                {position}/{count}
              </span>
            </>
          ) : (
            <Trans>
              {position} of {count}
            </Trans>
          )
        ) : count === 1 ? (
          <Trans>1 change</Trans>
        ) : (
          <Trans>{count} changes</Trans>
        )}
      </span>
      <IconButton
        size="xs"
        variant={touch || compact ? "quiet" : "outline"}
        className={arrow}
        tooltip={t`Next change`}
        disabled={disabled}
        onClick={() => onStep(1)}
      >
        <ChevronRight aria-hidden className={touch ? "size-5" : undefined} />
      </IconButton>
    </div>
  );
}
