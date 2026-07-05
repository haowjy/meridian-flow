/**
 * AgentChip — the inline agent-identity label (name + optional source badge).
 * `compact` is a Badge pill (results provenance); `readonly` is bare inline text
 * (picker rows own their own surface). Both are the same role — an agent label,
 * at two densities. The Library's summary card lives in AgentSummaryCard; the
 * composer's picker/lock lives in AgentSelector.
 */
import { t } from "@lingui/core/macro";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { type ResolvedAgentDisplay, sourceBadgeLabel } from "./resolve-agent";

export type AgentChipVariant = "readonly" | "compact";

export type AgentChipProps = {
  variant: AgentChipVariant;
  agent: ResolvedAgentDisplay;
  onClick?: () => void;
  className?: string;
  /** Positive provenance tooltip for readonly chips. */
  tooltip?: string;
};

export function AgentChip({ variant, agent, onClick, className, tooltip }: AgentChipProps) {
  const badge = sourceBadgeLabel(agent.source, agent.packageName);

  if (variant === "compact") {
    const chip = (
      <Badge
        variant="neutral"
        className={cn("max-w-[8rem] min-w-0 font-medium", !onClick && className)}
        title={onClick ? undefined : tooltip}
      >
        <span className="min-w-0 truncate">{agent.name}</span>
      </Badge>
    );
    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          title={tooltip}
          aria-label={t`Agent: ${agent.name}`}
          className={cn("focus-ring inline-flex min-w-0 cursor-pointer rounded-full", className)}
        >
          {chip}
        </button>
      );
    }
    return chip;
  }

  // readonly: name + optional source badge, no pill shell (picker rows own
  // their hover/selection surface).
  const body = (
    <>
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{agent.name}</span>
      {badge ? (
        <Badge variant="neutral" className="font-medium">
          {badge}
        </Badge>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={tooltip}
        aria-label={t`Agent: ${agent.name}`}
        className={cn(
          "focus-ring inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-md",
          className,
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      title={tooltip}
      className={cn("inline-flex min-w-0 max-w-full items-center gap-2", className)}
    >
      {body}
    </span>
  );
}
