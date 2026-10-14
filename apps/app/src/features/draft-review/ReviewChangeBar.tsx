/** Focused change attribution and Apply/Discard, one row on desktop and phone. Failures stay inline on the acted-on change. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

import type { ChangeFailure, DraftCommandFailure } from "@/client/query/draft-command-record";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChangeAuthor, ChangeFailureText, discardLabel } from "./ReviewChangeParts";
import { ReviewMessageText } from "./ReviewMessageText";
import type { ReviewChange } from "./review-model";

export type ReviewChangeBarProps = {
  change: ReviewChange;
  disabled: boolean;

  failure: ChangeFailure | null;
  draftFailure?: DraftCommandFailure | null;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
  className?: string;
};

export function ReviewChangeBar({
  change,
  disabled,

  failure,
  draftFailure,
  onApply,
  onDiscard,
  touch = false,
  className,
}: ReviewChangeBarProps) {
  const label = discardLabel();
  return (
    <section
      aria-label={t`Change`}
      data-review-change-bar={change.id}
      className={cn(
        touch
          ? "flex items-center gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2.5 text-caption shadow-card"
          : "flex w-full max-w-full items-center gap-2 rounded-lg border border-border bg-card px-1 py-1 pl-2 text-caption shadow-card",
        className,
      )}
    >
      <div className={cn("flex min-w-0 flex-1 items-center", touch ? "gap-3 py-0.5" : "gap-x-1.5")}>
        <div className="flex min-w-0 flex-1 items-center">
          <ChangeAuthor
            touch={touch}
            overflow="menu"
            chats={change.chats}
            className={touch ? "min-h-11" : undefined}
          />
        </div>
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
      </div>
      {failure || draftFailure ? (
        <p role="status" className="min-w-0 pr-2 text-meta text-destructive">
          {draftFailure ? (
            <ReviewMessageText failure={draftFailure} />
          ) : failure ? (
            <ChangeFailureText failure={failure} />
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
