/**
 * The lines a review can show beside its controls: why the last whole-draft
 * command was refused, which other drafts of the Work did not apply (the
 * review has moved on from them, so their rows alone would be easy to miss),
 * and, once the writer has handled the last change, "No changes left" with the
 * way on (the next draft, or back to live). The review does not jump on its
 * own, so the finished text can be read.
 *
 * Two kinds, because the two shells have different room. `ReviewFailureNotices`
 * are alerts that sit in a row of their own under the controls on both shells.
 * The review's state (`ReviewStateNotice`) is a row on the phone and, on the
 * desktop, an inline run in the identity row itself (`ReviewStateInline`), so
 * entering review never adds a second header. `touch` raises buttons to 44px.
 */
import { Plural, Trans } from "@lingui/react/macro";
import type { DraftCommandFailure } from "@/client/query/draft-command-record";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReviewNextAction, type ReviewStateProps, ReviewStatusContent } from "./ReviewCompletion";
import { ReviewMessageText } from "./ReviewMessageText";
import type { ReviewFileTarget } from "./review-files";

/** More refused drafts than this are summarised, so the notice never outgrows the header. */
const MAX_NAMED_FAILURES = 3;

export function ReviewFailureNotices({
  commandError,
  failedElsewhere = [],
  onOpenNext,
  touch = false,
  className,
}: {
  commandError: DraftCommandFailure | null;
  /** Other drafts of the Work whose last Apply or Discard was refused or lost. */
  failedElsewhere?: { row: ReviewFileTarget; failure: DraftCommandFailure }[];
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

/** The phone's row for the review's state, with 44px actions by touch. */
export function ReviewStateNotice({
  touch = false,
  ...state
}: ReviewStateProps & { touch?: boolean }) {
  if (!state.completing && !state.finished && !state.unlisted) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-border border-t px-4",
        touch ? (state.finished ? "py-1" : "py-2.5") : "py-1.5",
      )}
      role="status"
      aria-busy={!!state.completing}
    >
      <span className="flex flex-1 items-center gap-2 text-muted-foreground">
        <ReviewStatusContent {...state} />
      </span>
      {state.finished ? (
        <ReviewNextAction {...state} className={touch ? "h-11 px-4 text-sm" : undefined} />
      ) : null}
    </div>
  );
}

/** The desktop's state stays inside the identity row's 22px box. */
export function ReviewStateInline(state: ReviewStateProps) {
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
      {state.finished ? <ReviewNextAction {...state} className="h-5.5" /> : null}
    </span>
  );
}

/** The phone's notices: failures, then the review's state, each a row under the header. */
export function ReviewHeaderNotices({
  commandError,
  failedElsewhere,
  touch = false,
  ...state
}: ReviewStateProps & {
  commandError: DraftCommandFailure | null;
  failedElsewhere?: { row: ReviewFileTarget; failure: DraftCommandFailure }[];
  touch?: boolean;
}) {
  return (
    <>
      <ReviewFailureNotices
        commandError={commandError}
        failedElsewhere={failedElsewhere}
        onOpenNext={state.onOpenNext}
        touch={touch}
        className="px-4"
      />
      <ReviewStateNotice {...state} touch={touch} />
    </>
  );
}
