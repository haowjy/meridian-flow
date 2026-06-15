/**
 * AgentChip — shared agent identity primitive for composer, thread header, and
 * results provenance. Variants control density and interactivity; anatomy is
 * always [mark] [name?] [source-badge?] [chevron?].
 */
import { t } from "@lingui/core/macro";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import { initialsFromAgentName } from "./initials-mark";
import { type ResolvedAgentDisplay, sourceBadgeLabel } from "./resolve-agent";

export type AgentChipVariant = "interactive" | "readonly" | "compact" | "card";

export type AgentChipProps = {
  variant: AgentChipVariant;
  agent: ResolvedAgentDisplay;
  /** Optional package-provided icon; initials mark is the default. */
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
  /** Positive provenance tooltip for readonly header chips. */
  tooltip?: string;
};

export function AgentChip({ variant, agent, icon, onClick, className, tooltip }: AgentChipProps) {
  const badge = sourceBadgeLabel(agent.source, agent.packageName);
  const compactName = variant === "compact";
  const interactive = variant === "interactive";
  const initials = initialsFromAgentName(agent.name);

  const mark = icon ?? (
    <Avatar className={cn(compactName ? "size-6" : "size-7")}>
      {/* gradient-mark, not gradient-avatar: the olive avatar gradient is
          reserved for humans (AccountMenu). Agents are instruments — they ride
          the product-mark green so "person vs agent" stays legible at a glance
          in provenance rows. */}
      <AvatarFallback className="bg-gradient-mark text-fine font-semibold text-white">
        {initials}
      </AvatarFallback>
    </Avatar>
  );

  const body = (
    <>
      <span className="shrink-0">{mark}</span>
      <span
        className={cn(
          "min-w-0 truncate text-sm font-medium text-foreground",
          compactName && "max-w-[7rem]",
        )}
      >
        {agent.name}
      </span>
      {badge && variant !== "compact" ? (
        <span className="shrink-0 rounded-full border border-border-subtle bg-surface-subtle px-1.5 py-0.5 text-meta font-medium text-ink-subtle">
          {badge}
        </span>
      ) : null}
      {interactive ? (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </>
  );

  if (variant === "card") {
    return (
      <div
        className={cn(
          "flex w-full min-w-0 items-start gap-3 rounded-lg border border-border-subtle bg-card px-3 py-2.5",
          className,
        )}
      >
        <span className="shrink-0">{mark}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
            {badge ? (
              <span className="shrink-0 rounded-full border border-border-subtle bg-surface-subtle px-1.5 py-0.5 text-meta font-medium text-ink-subtle">
                {badge}
              </span>
            ) : null}
          </span>
          {agent.description ? (
            <span className="line-clamp-2 text-meta text-muted-foreground">
              {agent.description}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  const sharedClass = cn(
    "focus-ring inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border-subtle bg-card px-1.5 py-1 text-left transition-colors",
    interactive && "cursor-pointer hover:border-border-focus hover:bg-surface-subtle",
    !interactive && onClick && "cursor-pointer hover:border-border hover:bg-surface-subtle",
    className,
  );

  if (interactive || onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={tooltip}
        aria-label={t`Agent: ${agent.name}`}
        className={sharedClass}
      >
        {body}
      </button>
    );
  }

  return (
    <span title={tooltip} className={sharedClass}>
      {body}
    </span>
  );
}
