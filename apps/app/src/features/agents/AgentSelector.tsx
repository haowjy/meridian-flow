/**
 * AgentSelector — the composer's agent control. One component, two states:
 *  - **enabled**: a picker trigger (agent name + chevron) — opens AgentPicker.
 *  - **disabled**: settled (muted agent name, no trailing glyph) — the thread
 *    has started, so swapping is cost-gated for now (coming later). The absent
 *    chevron removes the picker affordance; the tooltip says why.
 *
 * Rendered as a real <button> so Radix `PopoverTrigger asChild` gets a focusable
 * host. Disabled uses `aria-disabled` (not the native attr) so the tooltip still
 * shows on hover.
 */
import { t } from "@lingui/core/macro";
import { ChevronDown } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ResolvedAgentDisplay } from "./resolve-agent";

export type AgentSelectorProps = {
  agent: ResolvedAgentDisplay;
  disabled?: boolean;
  onClick?: () => void;
  tooltip?: string;
  className?: string;
};

export function AgentSelector({
  agent,
  disabled = false,
  onClick,
  tooltip,
  className,
}: AgentSelectorProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      title={tooltip}
      aria-label={t`Agent: ${agent.name}`}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "focus-ring max-w-[11rem] min-w-0 font-medium",
        disabled &&
          "cursor-default border-transparent bg-transparent text-muted-foreground opacity-60 shadow-none hover:border-transparent hover:bg-transparent",
        className,
      )}
    >
      <span className="min-w-0 truncate">{agent.name}</span>
      {!disabled ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  );
}
