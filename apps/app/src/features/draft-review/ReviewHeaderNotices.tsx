/** Whole-draft failures and inline review completion. End states share the existing review/path row rather than adding a banner. */
import { Plural, Trans } from "@lingui/react/macro";
import type { BranchCommandFailure } from "./review-command-types";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReviewNextAction, type ReviewStateProps, ReviewStatusContent } from "./ReviewCompletion";
import { ReviewMessageText } from "./ReviewMessageText";

/** More refused drafts than this are summarised, so the notice never outgrows the header. */
const MAX_NAMED_FAILURES = 3;

export function ReviewFailureNotices({
  commandError,
  failedElsewhere = [],
  onOpenNext,
  touch = false,
  className,
}: {
  commandError: BranchCommandFailure | null;
  /** Other drafts of the Work whose last Apply or Discard was refused or lost. */
  failedElsewhere?: { row: ReviewFileTarget; failure: BranchCommandFailure }[];
  onOpenNext: (row: ReviewFileTarget) => void;
  touch?: boolean;
  /** The inset of whatever hosts the notices. */
  className?: string;
}) {
  const button = touch ? "h-11 px-4 text-sm" : undefined;
  return (
    <>
      {commandError ? (
        <p className={cn("pb-1.5 text-destructive", className)} role="alert">
          <ReviewMessageText failure={commandError} />
        </p>
      ) : null}
      {failedElsewhere.slice(0, MAX_NAMED_FAILURES).map(({ row, failure }) => (
        <div
          key={row.documentId}
          className={cn(
            "flex items-center gap-3 border-border border-t py-1 text-destructive",
            className,
          )}
          role="alert"
        >
          <p className="min-w-0 flex-1">
            <span className="font-medium">{row.documentName ?? <Trans>Untitled</Trans>}</span>
            <br />
            <ReviewMessageText failure={failure} />
          </p>
          <Button size="xs" variant="outline" className={button} onClick={() => onOpenNext(row)}>
            <Trans>Open</Trans>
          </Button>
        </div>
      ))}
      {failedElsewhere.length > MAX_NAMED_FAILURES ? (
        <p className={cn("border-border border-t py-1 text-destructive", className)} role="alert">
          <Plural
            value={failedElsewhere.length - MAX_NAMED_FAILURES}
            one="Changes in # more document did not apply"
            other="Changes in # more documents did not apply"
          />
        </p>
      ) : null}
    </>
  );
}

/** The desktop's state stays inside the identity row's 22px box. */
export function ReviewStateInline({
  touch = false,
  ...state
}: ReviewStateProps & { touch?: boolean }) {
  if (!state.finished && !state.completing && !state.unlisted) return null;
  return (
    <span
      role="status"
      aria-busy={!!state.completing}
      className="flex min-w-0 items-center gap-2 font-sans text-xs"
    >
      <span
        className={cn(
          "text-muted-foreground",
          state.unlisted
            ? "min-w-0 truncate"
            : "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
        )}
      >
        <ReviewStatusContent {...state} />
      </span>
      {state.finished ? (
        <ReviewNextAction {...state} className={touch ? "h-11 px-2" : "h-5.5"} />
      ) : null}
    </span>
  );
}
