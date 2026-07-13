import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { ChevronLeft } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { lifecycleDisplay, lifecycleFor } from "../lifecycle";

export type SubagentBannerProps = {
  subagent: Thread;
  parent: Thread | null;
  onOpenParent: (threadId: string) => void;
};

/**
 * Sticky 36-44px banner above the subagent conversation. Surfaces the parent
 * thread link, the subagent's own title, and its lifecycle pill.
 */
export function SubagentBanner({ subagent, parent, onOpenParent }: SubagentBannerProps) {
  const lifecycle = lifecycleFor(subagent);
  const display = lifecycleDisplay(lifecycle);

  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-warm px-4 py-2 text-xs",
      )}
    >
      {parent ? (
        <button
          type="button"
          onClick={() => onOpenParent(parent.id)}
          className="focus-ring inline-flex cursor-pointer items-center gap-1 rounded text-primary hover:text-primary/80"
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

      <span className="text-ink-subtle">•</span>
      <span className="text-muted-foreground">
        <Trans>Subagent:</Trans>
      </span>
      <span className="font-medium text-ink-strong">{subagent.title?.trim() || "Subtask"}</span>

      <span className="text-ink-subtle">•</span>
      <Badge variant="status" className={display.badgeClass}>
        <span
          className={cn(
            "size-1.5 rounded-full",
            lifecycle === "executing" || lifecycle === "grilling"
              ? "bg-status-streaming"
              : lifecycle === "interrupt"
                ? "bg-destructive"
                : lifecycle === "completed"
                  ? "bg-status-done-foreground"
                  : "bg-ink-subtle",
          )}
          aria-hidden
        />
        {display.label}
      </Badge>
    </div>
  );
}
