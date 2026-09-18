import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { ChevronLeft } from "lucide-react";

export type SubagentBannerProps = {
  subagent: Thread;
  parent: Thread | null;
  onOpenParent: (threadId: string) => void;
};

/**
 * Sticky 36-44px banner above the subagent conversation. Surfaces the parent
 * thread link and the subagent's own title. Run state stays on the composer.
 */
export function SubagentBanner({ subagent, parent, onOpenParent }: SubagentBannerProps) {
  return (
    <div className="sticky top-0 z-10 flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs">
      {parent ? (
        <button
          type="button"
          onClick={() => onOpenParent(parent.id)}
          className="focus-ring inline-flex items-center gap-1 rounded text-primary hover:text-primary/80"
          aria-label="Go to parent chat"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          <span className="text-muted-foreground">
            <Trans>Parent:</Trans>
          </span>
          <span className="font-medium">{parent.title?.trim() || "Untitled"}</span>
        </button>
      ) : (
        <span className="text-muted-foreground">
          <Trans>Parent unknown</Trans>
        </span>
      )}

      <span className="text-muted-foreground">
        <Trans>Subagent:</Trans>
      </span>
      <span className="font-medium text-prose-foreground">
        {subagent.title?.trim() || "Subtask"}
      </span>
    </div>
  );
}
