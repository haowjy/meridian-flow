/**
 * AgentPicker — Radix popover listing installed then built-in agents from the
 * project catalog. Quiet loading/empty/error states; no default-agent or
 * Library links yet (later lanes).
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectAgentSummary } from "@meridian/contracts/agents";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectAgentsStatus } from "@/client/query/useProjectAgents";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

import { AgentChip } from "./AgentChip";
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
              {/* TODO(library): "Manage agents…" link → ?screen=library */}
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
          return (
            <li key={agent.slug}>
              <button
                type="button"
                onClick={() => onSelect(agent.slug)}
                className={cn(
                  "focus-ring flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent",
                  active && "bg-primary/10",
                )}
              >
                <AgentChip
                  variant="readonly"
                  agent={resolveAgentFromCatalog(agent.slug, [agent])}
                />
                {agent.description ? (
                  <span className="line-clamp-2 pl-9 text-meta text-muted-foreground">
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
  return (
    <div className="flex items-center gap-2 px-3 py-4">
      <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 text-sm text-foreground">
        <Trans>Couldn't load agents.</Trans>
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring shrink-0 text-sm font-medium text-primary underline-offset-2 hover:underline"
      >
        <Trans>Retry</Trans>
      </button>
    </div>
  );
}
