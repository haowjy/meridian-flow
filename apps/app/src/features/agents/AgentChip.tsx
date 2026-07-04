/**
 * AgentChip — shared agent identity primitive for composer, thread header, and
 * results provenance. Name-forward: no avatar/initials mark — agent identity is
 * the name plus an optional source badge, styled through the shared Badge and
 * Button primitives so agent chrome matches the rest of the app.
 */
import { t } from "@lingui/core/macro";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { type ResolvedAgentDisplay, sourceBadgeLabel } from "./resolve-agent";

export type AgentChipVariant = "interactive" | "readonly" | "compact" | "card" | "inline";

export type AgentChipProps = {
  variant: AgentChipVariant;
  agent: ResolvedAgentDisplay;
  onClick?: () => void;
  className?: string;
  /** Positive provenance tooltip for readonly header chips. */
  tooltip?: string;
};

export function AgentChip({ variant, agent, onClick, className, tooltip }: AgentChipProps) {
  const badge = sourceBadgeLabel(agent.source, agent.packageName);

  if (variant === "card") {
    return (
      <div
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-border-subtle bg-card px-3 py-2.5",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
          {badge ? <SourceBadge>{badge}</SourceBadge> : null}
        </span>
        {agent.description ? (
          <span className="line-clamp-2 text-meta text-muted-foreground">{agent.description}</span>
        ) : null}
      </div>
    );
  }

  if (variant === "inline") {
    // Pane-header provenance: a quiet text label, no pill chrome, hover
    // matching the adjacent thread-switcher trigger.
    const inlineClass = cn(
      "inline-flex min-w-0 items-center rounded-md px-1 py-0.5 text-meta font-medium text-ink-subtle",
      onClick &&
        "focus-ring cursor-pointer transition-colors hover:bg-sidebar-accent hover:text-foreground",
      className,
    );
    const name = <span className="min-w-0 max-w-[9rem] truncate">{agent.name}</span>;
    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          title={tooltip}
          aria-label={t`Agent: ${agent.name}`}
          className={inlineClass}
        >
          {name}
        </button>
      );
    }
    return (
      <span title={tooltip} className={inlineClass}>
        {name}
      </span>
    );
  }

  if (variant === "interactive") {
    // Picker trigger: same quiet outline chrome as other small CTAs. Rendered
    // as a real button so Radix `PopoverTrigger asChild` gets a focusable host.
    return (
      <button
        type="button"
        onClick={onClick}
        title={tooltip}
        aria-label={t`Agent: ${agent.name}`}
        className={cn(
          buttonVariants({ variant: "outline", size: "xs" }),
          "focus-ring max-w-[11rem] min-w-0 font-medium",
          className,
        )}
      >
        <span className="min-w-0 truncate">{agent.name}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    );
  }

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
      {badge ? <SourceBadge>{badge}</SourceBadge> : null}
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

function SourceBadge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-full border border-border-subtle bg-surface-subtle px-1.5 py-0.5 text-meta font-medium text-ink-subtle">
      {children}
    </span>
  );
}
