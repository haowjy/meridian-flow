/** Whole-draft failures and inline review completion. End states share the existing review/path row rather than adding a banner. */
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { cn } from "@/lib/utils";
import { useDraftCommandState } from "./draft-changes";
import { ReviewNextAction, type ReviewStateProps, ReviewStatusContent } from "./ReviewCompletion";
import { ReviewMessageText } from "./ReviewMessageText";
import type { BranchCommandFailure } from "./review-command-types";

export function ReviewFailureNotices({
  commandError,
  className,
}: {
  commandError: BranchCommandFailure | null;
  /** The inset of whatever hosts the notices. */
  className?: string;
}) {
  return commandError ? (
    <InlineErrorRow message={<ReviewMessageText failure={commandError} />} className={className} />
  ) : null;
}

/**
 * The desktop's state stays inside the identity row's 22px box. Once no change is left, nothing
 * else shows the draft's failure (a Ctrl+Z that couldn't take a Discard back), so it takes the
 * place of "No changes left" and wraps.
 */
export function ReviewStateInline({
  touch = false,
  itemKey,
  ...state
}: ReviewStateProps & { itemKey: string; touch?: boolean }) {
  const { failure } = useDraftCommandState(itemKey);
  if (!state.finished && !state.completing) return null;
  const failed = state.finished && failure;
  return (
    <span
      role="status"
      aria-busy={!!state.completing}
      className={cn(
        "flex min-w-0 items-center gap-2 font-sans text-xs",
        // The desktop band's controls take the line once finished; this keeps to its end.
        !touch && "ml-auto",
        // Next draft wraps under a failure that can't get 10rem beside it.
        failed && "flex-1 flex-wrap justify-end gap-y-1",
      )}
    >
      {failed ? (
        <ReviewFailureNotices commandError={failure} className="min-w-0 grow basis-40 p-0" />
      ) : (
        <span
          className={cn(
            "text-muted-foreground",
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
          )}
        >
          <ReviewStatusContent {...state} />
        </span>
      )}
      {state.finished ? (
        <ReviewNextAction {...state} className={touch ? "h-11 px-2" : "h-6"} />
      ) : null}
    </span>
  );
}
