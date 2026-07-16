/**
 * AgentPicker — Radix popover listing installed then built-in agents from the
 * project catalog with quiet loading, empty, and error states.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectAgentSummary } from "@meridian/contracts/agents";
import type { ReactNode } from "react";
import type { ProjectAgentsStatus } from "@/client/query/useProjectAgents";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { sourceBadgeLabel } from "@/lib/source-badge";
import { cn } from "@/lib/utils";

import { resolveAgentFromCatalog } from "./resolve-agent";

export type AgentPickerProps = {
  status: ProjectAgentsStatus;
  selectedSlug: string;
  onSelect: (slug: string) => void;
  trigger: ReactNode;
};

export function AgentPicker({ status, selectedSlug, onSelect, trigger }: AgentPickerProps) {
  const agents = status.agents ?? [];
  const installed = agents.filter((agent) => agent.source === "package" || agent.source === "user");
  const builtins = agents.filter((agent) => agent.source === "builtin");

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex max-h-[min(60vh,24rem)] flex-col overflow-y-auto p-1">
          {status.status === "loading" || status.status === "disabled" ? (
            <PickerHint>
              <Trans>Loading agents…</Trans>
            </PickerHint>
          ) : status.status === "error" ? (
            <ErrorHint onRetry={status.refetch} />
          ) : status.status === "empty" ? (
            <PickerHint>
              <Trans>No agents available.</Trans>
            </PickerHint>
          ) : (
            <>
              {installed.length > 0 ? (
                <AgentGroup
                  title={t`Installed`}
                  agents={installed}
                  selectedSlug={selectedSlug}
                  onSelect={onSelect}
                />
              ) : null}
              {builtins.length > 0 ? (
                <AgentGroup
                  title={t`Built-in`}
                  agents={builtins}
                  selectedSlug={selectedSlug}
                  onSelect={onSelect}
                />
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentGroup({
  title,
  agents,
  selectedSlug,
  onSelect,
}: {
  title: string;
  agents: ProjectAgentSummary[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <section className="py-1">
      <p className={cn(sectionLabelVariants({ variant: "section" }), "px-2 py-1")}>{title}</p>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const active = agent.slug === selectedSlug;
          const display = resolveAgentFromCatalog(agent.slug, [agent]);
          const badge = sourceBadgeLabel(display.source, display.packageName);
          return (
            <li key={agent.slug}>
              <button
                type="button"
                onClick={() => onSelect(agent.slug)}
                className={cn(
                  "focus-ring flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors",
                  // Pressed neutral, not an accent wash — routine selection
                  // never spends jade (same grammar as sidebar rows).
                  active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
                )}
              >
                <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {display.name}
                  </span>
                  {badge ? (
                    <Badge variant="neutral" className="font-medium">
                      {badge}
                    </Badge>
                  ) : null}
                </span>
                {agent.description ? (
                  <span className="line-clamp-2 text-meta text-muted-foreground">
                    {agent.description}
                  </span>
                ) : null}
                {/* TODO(default-agent): per-row "Set as default" affordance */}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PickerHint({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-sm text-muted-foreground">{children}</p>;
}

function ErrorHint({ onRetry }: { onRetry: () => void }) {
  return <InlineErrorRow message={t`Couldn't load agents.`} onRetry={onRetry} />;
}
