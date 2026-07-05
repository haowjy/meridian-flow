/**
 * AgentSummaryCard — a bordered summary of an agent (name + source badge +
 * description). Used in the Library, where an agent is a browsable item. This is
 * a card, not an identity chip — kept separate from AgentChip so neither has to
 * pretend to be the other (was `AgentChip variant="card"`).
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { type ResolvedAgentDisplay, sourceBadgeLabel } from "./resolve-agent";

export function AgentSummaryCard({
  agent,
  className,
}: {
  agent: ResolvedAgentDisplay;
  className?: string;
}) {
  const badge = sourceBadgeLabel(agent.source, agent.packageName);
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-border-subtle bg-card px-3 py-2.5",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
        {badge ? (
          <Badge variant="neutral" className="font-medium">
            {badge}
          </Badge>
        ) : null}
      </span>
      {agent.description ? (
        <span className="line-clamp-2 text-meta text-muted-foreground">{agent.description}</span>
      ) : null}
    </div>
  );
}
