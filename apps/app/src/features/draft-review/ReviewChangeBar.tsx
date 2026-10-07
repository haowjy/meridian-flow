/**
 * ReviewChangeBar — the compact one-line bar for the change the writer is
 * looking at: the chat that wrote it, a note when it needs a second look,
 * Discard and Apply. Where it sits (beside the change in the manuscript, above
 * the keyboard on a phone) is its host's business; this is only the bar.
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
  className?: string;
};

export function ReviewChangeBar({
  change,
  disabled,
  canApply,
  failure,
  onApply,
  onDiscard,
  className,
}: ReviewChangeBarProps) {
  return (
    <section
      aria-label={t`Change`}
      data-review-change-bar={change.classId}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border border-border bg-card px-1 py-1 pl-2.5 text-caption shadow-card",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 whitespace-nowrap">
        <ChangeAuthor attribution={change.attribution} />
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
        <span className="flex-1" />
        <Button variant="quiet" size="xs" disabled={disabled} onClick={onDiscard}>
          {discardLabel(change)}
        </Button>
        {canApply ? (
          <Button size="xs" disabled={disabled} onClick={onApply}>
            <Trans>Apply</Trans>
          </Button>
        ) : null}
      </div>
      {failure ? (
        <p role="status" className="pr-2 text-meta text-destructive">
          <ChangeFailureText code={failure.code} mode={failure.mode} />
        </p>
      ) : null}
    </section>
  );
}
