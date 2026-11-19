/** The review's completion state, inline in its identity row. */
import { cn } from "@/lib/utils";
import { ReviewNextAction, type ReviewStateProps, ReviewStatusContent } from "./ReviewCompletion";

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
      className={cn(
        "flex min-w-0 items-center gap-2 font-sans text-xs",
        // The desktop band's controls take the line once finished; this keeps to its end.
        !touch && "ml-auto",
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground">
        <ReviewStatusContent {...state} />
      </span>
      {state.finished ? (
        <ReviewNextAction {...state} className={touch ? "h-11 px-2" : "h-6"} />
      ) : null}
    </span>
  );
}
