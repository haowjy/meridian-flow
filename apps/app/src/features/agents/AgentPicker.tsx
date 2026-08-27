/**
 * AgentPicker — Radix popover listing installed then built-in agents from the
 * project catalog with quiet loading, empty, and error states.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectAgentSummary } from "@meridian/contracts/agents";
import type { ReactNode, RefObject } from "react";
import type { ProjectAgentsStatus } from "@/client/query/useProjectAgents";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Badge } from "@/components/ui/badge";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import {
  dropdownResultsVariants,
  dropdownRowVariants,
  dropdownSurfaceVariants,
} from "@/components/ui/dropdown-presentation";
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
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        align="start"
        className={dropdownSurfaceVariants({ measure: "identity", page: "picker" })}
      >
        <AgentPickerPanel status={status} selectedSlug={selectedSlug} onSelect={onSelect} />
      </PopoverContent>
    </Popover>
  );
}

export function AgentPickerPanel({
  status,
  selectedSlug,
  onSelect,
  focusRefs,
}: Omit<AgentPickerProps, "trigger"> & {
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
}) {
  const agents = status.agents ?? [];
  const installed = agents.filter((agent) => agent.source === "package" || agent.source === "user");
  const builtins = agents.filter((agent) => agent.source === "builtin");
  const firstSlug = agents[0]?.slug;

  return (
    <div className={cn(dropdownResultsVariants({ kind: "picker" }), "flex flex-col")}>
      {status.status === "loading" || status.status === "disabled" ? (
        <PickerHint>
          <Trans>Loading agents…</Trans>
        </PickerHint>
      ) : status.status === "error" ? (
        <ErrorHint onRetry={status.refetch} retryRef={focusRefs?.retry} />
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
              focusRefs={focusRefs}
              firstSlug={firstSlug}
            />
          ) : null}
          {builtins.length > 0 ? (
            <AgentGroup
              title={t`Built-in`}
              agents={builtins}
              selectedSlug={selectedSlug}
              onSelect={onSelect}
              focusRefs={focusRefs}
              firstSlug={firstSlug}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function AgentGroup({
  title,
  agents,
  selectedSlug,
  onSelect,
  focusRefs,
  firstSlug,
}: {
  title: string;
  agents: ProjectAgentSummary[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
  };
  firstSlug?: string;
}) {
  return (
    <section>
      <p className={cn(sectionLabelVariants({ variant: "group" }), "mb-1 px-2")}>{title}</p>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const active = agent.slug === selectedSlug;
          const display = resolveAgentFromCatalog(agent.slug, [agent]);
          const badge = sourceBadgeLabel(display.source, display.packageName);
          return (
            <li key={agent.slug}>
              <button
                ref={
                  agent.slug === selectedSlug
                    ? focusRefs?.selected
                    : agent.slug === firstSlug
                      ? focusRefs?.first
                      : undefined
                }
                type="button"
                onClick={() => onSelect(agent.slug)}
                className={cn(
                  dropdownRowVariants({ kind: "identity", selected: active }),
                  // Pressed neutral, not an accent wash — routine selection
                  // never spends jade (same grammar as sidebar rows).
                  active && "font-medium",
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
                  <span className="line-clamp-1 text-meta text-muted-foreground">
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

function ErrorHint({
  onRetry,
  retryRef,
}: {
  onRetry: () => void;
  retryRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <InlineErrorRow message={t`Couldn't load agents.`} onRetry={onRetry} retryRef={retryRef} />
  );
}
