/**
 * LiveTurnStatusBar — compact status row for the currently streaming assistant
 * turn. It keeps live-state labels and the tokenized streaming dot in one leaf
 * so chat renderers don't duplicate progress chrome.
 *
 * Visibility is now decided by the unified turn render path (`AssistantTurn`)
 * from the `Turn.status` — there is no separate live-state predicate, because
 * live and settled turns share one block model.
 */
import { Trans } from "@lingui/react/macro";
import { cn } from "@/lib/utils";

export type LiveTurnStatusBarProps = {
  className?: string;
};

/**
 * Footer chrome for an in-progress assistant turn. Always render at the
 * **bottom** of the turn body so it does not jump between reasoning and
 * answer.
 */
export function LiveTurnStatusBar({ className }: LiveTurnStatusBarProps) {
  return (
    <div
      className={cn("mt-3 flex items-center gap-2 pl-0.5", className)}
      role="status"
      aria-live="polite"
    >
      <span
        className="streaming-dot size-[7px] shadow-[0_0_0_3px_var(--color-status-streaming-ring-strong)]"
        aria-hidden
      />
      <span className="text-micro font-semibold tracking-status text-primary uppercase">
        <Trans>Working</Trans>
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
