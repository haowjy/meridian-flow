/** Whole-draft failures and inline review completion. End states share the existing review/path row rather than adding a banner. */
import { Plural, Trans } from "@lingui/react/macro";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { cn } from "@/lib/utils";
import { useDraftCommandState } from "./draft-changes";
import { ReviewNextAction, type ReviewStateProps, ReviewStatusContent } from "./ReviewCompletion";
import { ReviewMessageText } from "./ReviewMessageText";
import type { BranchCommandFailure } from "./review-command-types";

/** More refused drafts than this are summarised, so the notice never outgrows the header. */
const MAX_NAMED_FAILURES = 3;

export function ReviewFailureNotices({
  commandError,
  itemKey = "",
  failedElsewhere = [],
  onOpenNext,
  className,
}: {
  commandError: BranchCommandFailure | null;
  itemKey?: string;
  /** Other drafts of the Work whose last Apply or Discard was refused or lost. */
  failedElsewhere?: { row: ReviewFileTarget; failure: BranchCommandFailure }[];
  onOpenNext: (row: ReviewFileTarget) => void;
  /** The inset of whatever hosts the notices. */
  className?: string;
}) {
  const owner = useDraftCommandOwner();
  const command = useDraftCommandState(itemKey);
  return (
    <>
      {commandError ? (
        <InlineErrorRow
          message={<ReviewMessageText failure={commandError} />}
          onRetry={
            commandError.code === "unapply-refused" && command.stalled
              ? () => owner.retry(itemKey)
              : undefined
          }
          className={className}
        />
      ) : null}
      {failedElsewhere.slice(0, MAX_NAMED_FAILURES).map(({ row, failure }) => (
        <InlineErrorRow
          key={row.documentId}
          message={
            <>
              <span className="font-medium">{row.documentName ?? <Trans>Untitled</Trans>}</span>
              <br />
              <ReviewMessageText failure={failure} />
            </>
          }
          onRetry={() => onOpenNext(row)}
          actionLabel={<Trans>Open</Trans>}
          className={className}
        />
      ))}
      {failedElsewhere.length > MAX_NAMED_FAILURES ? (
        <InlineErrorRow
          message={
            <Plural
              value={failedElsewhere.length - MAX_NAMED_FAILURES}
              one="Changes in # more document did not apply"
              other="Changes in # more documents did not apply"
            />
          }
          className={className}
        />
      ) : null}
    </>
  );
}

/** The desktop's state stays inside the identity row's 22px box. */
export function ReviewStateInline({
  touch = false,
  ...state
}: ReviewStateProps & { touch?: boolean }) {
  if (!state.finished && !state.completing) return null;
  return (
    <span
      role="status"
      aria-busy={!!state.completing}
      className="flex min-w-0 items-center gap-2 font-sans text-xs"
    >
      <span
        className={cn(
          "text-muted-foreground",
          "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
        )}
      >
        <ReviewStatusContent {...state} />
      </span>
      {state.finished ? (
        <ReviewNextAction {...state} className={touch ? "h-11 px-2" : "h-6"} />
      ) : null}
    </span>
  );
}
