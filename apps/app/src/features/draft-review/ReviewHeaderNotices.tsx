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
import { Loader2 } from "lucide-react";
import type { DraftCommandFailure } from "@/client/query/draft-command-record";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReviewMessageText } from "./ReviewMessageText";
import type { ReviewFileTarget } from "./review-files";

/** More refused drafts than this are summarised, so the notice never outgrows the header. */
const MAX_NAMED_FAILURES = 3;

export type ReviewStateProps = {
  finished: boolean;
  /** The draft is open and lists no change: what remains is handled by Apply draft or Discard draft. */
  unlisted?: boolean;
  /** The last change's command is in flight: nothing is finished yet. */
  completing?: "apply" | "discard" | null;
  next: ReviewFileTarget | null;
  draftOnly: boolean;
  onOpenNext: (row: ReviewFileTarget) => void;
  onShowLive: () => void;
};

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
            one="# more draft did not apply"
            other="# more drafts did not apply"
          />
        </p>
      ) : null}
    </>
  );
}

/** The phone's rows for the review's state. */
export function ReviewStateNotice({
  completing = null,
  unlisted = false,
  finished,
  next,
  draftOnly,
  onOpenNext,
  onShowLive,
  touch = false,
}: ReviewStateProps & { touch?: boolean }) {
  const button = touch ? "h-11 px-4 text-sm" : undefined;
  return (
    <>
      {completing ? (
        <div
          className={cn(
            "flex items-center gap-2 border-border border-t px-4 text-muted-foreground",
            touch ? "py-2.5" : "py-1.5",
          )}
          role="status"
          aria-busy
        >
          <Loader2 className="size-3 animate-spin" aria-hidden />
          <p>{completing === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}</p>
        </div>
      ) : null}
      {unlisted ? (
        <p
          className={cn(
            "border-border border-t px-4 text-muted-foreground",
            touch ? "py-2.5" : "py-1.5",
          )}
          role="status"
        >
          <Trans>Formatting changes remain</Trans>
        </p>
      ) : null}
      {finished ? (
        <div
          className={cn(
            "flex items-center gap-3 border-border border-t px-4",
            touch ? "py-1" : "py-1.5",
          )}
          role="status"
        >
          <p className="flex-1 text-muted-foreground">
            <Trans>No changes left</Trans>
          </p>
          {next ? (
            <Button size="xs" className={button} onClick={() => onOpenNext(next)}>
              <Trans>Next draft</Trans>
            </Button>
          ) : (
            <Button size="xs" variant="outline" className={button} onClick={onShowLive}>
              {draftOnly ? <Trans>Close review</Trans> : <Trans>Back to live</Trans>}
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}

/** The desktop's run for the review's state, inside the identity row, at the 22px box. */
export function ReviewStateInline({
  completing = null,
  unlisted = false,
  finished,
  next,
  draftOnly,
  onOpenNext,
  onShowLive,
}: ReviewStateProps) {
  const button = "h-5.5";
  if (finished) {
    return (
      <span role="status" className="flex shrink-0 items-center gap-2 font-sans text-xs">
        <span className="whitespace-nowrap text-muted-foreground">
          <Trans>No changes left</Trans>
        </span>
        {next ? (
          <Button size="xs" className={button} onClick={() => onOpenNext(next)}>
            <Trans>Next draft</Trans>
          </Button>
        ) : (
          <Button size="xs" variant="outline" className={button} onClick={onShowLive}>
            {draftOnly ? <Trans>Close review</Trans> : <Trans>Back to live</Trans>}
          </Button>
        )}
      </span>
    );
  }
  if (completing) {
    return (
      <span
        role="status"
        aria-busy
        className="flex shrink-0 items-center gap-1.5 font-sans text-muted-foreground text-xs"
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {completing === "apply" ? <Trans>Applying</Trans> : <Trans>Discarding</Trans>}
      </span>
    );
  }
  if (unlisted) {
    return (
      <span role="status" className="min-w-0 truncate font-sans text-muted-foreground text-xs">
        <Trans>Formatting changes remain</Trans>
      </span>
    );
  }
  return null;
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
