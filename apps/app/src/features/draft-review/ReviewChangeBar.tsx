/**
 * ReviewChangeBar — the compact one-line bar for the change the writer is
 * looking at: the chat that wrote it, a note when it needs a second look,
 * Discard and Apply. Where it sits (beside the change in the manuscript, above
 * the keyboard on a phone) is its host's business; this is only the bar. On
 * desktop it wraps to two rows when its host is narrow, buttons together on
 * the last.
 *
 * `touch` is the phone's bar: who and why stack on the left, and Discard and
 * Apply are 44px targets on the right. Discard reads just "Discard" there, as
 * "Includes your edits" stands beside it; its accessible name stays in full.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

import type { ChangeCommandState } from "@/client/query/change-command-record";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChangeAuthor, ChangeFailureText, discardLabel } from "./ReviewChangeParts";
import type { ReviewChange } from "./review-changes";

export type ReviewChangeBarProps = {
  change: ReviewChange;
  disabled: boolean;
  canApply: boolean;
  failure: Extract<ChangeCommandState, { phase: "failed" }> | null;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
  className?: string;
};

export function ReviewChangeBar({
  change,
  disabled,
  canApply,
  failure,
  onApply,
  onDiscard,
  touch = false,
  className,
}: ReviewChangeBarProps) {
  const label = discardLabel(change);
  return (
    <section
      aria-label={t`Change`}
      data-review-change-bar={change.classId}
      className={cn(
        touch
          ? "flex flex-col gap-0.5 rounded-lg border border-border bg-card px-1 py-1 pl-2.5 text-caption shadow-card"
          : "flex w-fit max-w-full flex-col gap-0.5 rounded-lg border border-border bg-card px-1 py-1 pl-2 text-caption shadow-card",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center",
          touch ? "gap-3 py-0.5" : "flex-wrap gap-x-1.5 gap-y-0.5",
        )}
      >
        <div className={touch ? "flex min-w-0 flex-1 flex-col items-start" : "contents"}>
          <ChangeAuthor
            attribution={change.attribution}
            className={
              touch
                ? cn(
                    "inline-flex min-h-11 max-w-[60%] items-center",
                    // The note sits in the link's padding, so the pair stays two lines tall.
                    (change.includesWriterEdits || change.merged) && "-mb-3",
                  )
                : "max-w-[60%]"
            }
          />
          {change.includesWriterEdits ? (
            <span className="text-meta text-muted-foreground">
              <Trans>Includes your edits</Trans>
            </span>
          ) : null}
          {change.merged ? (
            <span className="text-meta text-muted-foreground">
              <Trans>Check it reads right</Trans>
            </span>
          ) : null}
          {change.actionable ? null : (
            <span className="text-meta text-muted-foreground">
              <Trans>Apply draft or Discard draft handles this.</Trans>
            </span>
          )}
        </div>
        {change.actionable ? (
          <span
            className={
              touch
                ? "flex items-center gap-3"
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
            {canApply ? (
              <Button
                size="xs"
                className={touch ? "h-11 min-w-20 px-5 text-sm" : undefined}
                disabled={disabled}
                onClick={onApply}
              >
                <Trans>Apply</Trans>
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {failure ? (
        <p role="status" className="pr-2 text-meta text-destructive">
          <ChangeFailureText failure={failure} />
        </p>
      ) : null}
    </section>
  );
}
