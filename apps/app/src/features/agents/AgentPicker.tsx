/**
 * AgentPickerPanel — personal and system entries from the exact Agent catalog
 * with quiet loading, empty, and error states.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import type { ReactNode, RefObject } from "react";
import type { CreationAgent } from "@/client/first-send-continuity";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Badge } from "@/components/ui/badge";
import {
  dropdownResultsVariants,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { sectionLabelVariants } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

type AgentPickerPanelProps = {
  status: AgentCatalogStatus;
  selectedAgent: CreationAgent | null;
  onSelect: (agent: CreationAgent) => void;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
};

export function AgentPickerPanel({
  status,
  selectedAgent,
  onSelect,
  focusRefs,
}: AgentPickerPanelProps) {
  const agents = status.agents ?? [];
  const installed = agents.filter((agent) => agent.ownership === "personal");
  const builtins = agents.filter((agent) => agent.ownership === "system");
  const firstId = agents.find((agent) => !agent.unavailableReasons.length)?.selection
    .catalogEntryId;

  return (
    <div className={cn(dropdownResultsVariants({ kind: "picker" }), "flex flex-col")}>
      {status.status === "loading" || status.status === "disabled" ? (
        <PickerHint>
          <Trans>Loading agents…</Trans>
        </PickerHint>
      ) : status.status === "error" ? (
        <InlineErrorRow
          message={t`Couldn't load agents.`}
          onRetry={status.refetch}
          retryRef={focusRefs?.retry}
        />
      ) : status.status === "empty" ? (
        <PickerHint>
          <Trans>No agents available.</Trans>
        </PickerHint>
      ) : (
        <>
          {installed.length > 0 ? (
            <AgentGroup
              title={t`Personal`}
              agents={installed}
              selectedAgent={selectedAgent}
              onSelect={onSelect}
              focusRefs={focusRefs}
              firstId={firstId}
            />
          ) : null}
          {builtins.length > 0 ? (
            <AgentGroup
              title={t`System`}
              agents={builtins}
              selectedAgent={selectedAgent}
              onSelect={onSelect}
              focusRefs={focusRefs}
              firstId={firstId}
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
  selectedAgent,
  onSelect,
  focusRefs,
  firstId,
}: {
  title: string;
  agents: AgentCatalogItem[];
  selectedAgent: CreationAgent | null;
  onSelect: (agent: CreationAgent) => void;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
  };
  firstId?: string;
}) {
  return (
    <section>
      <p className={cn(sectionLabelVariants({ variant: "group" }), "mb-1 px-2")}>{title}</p>
      <ul className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const active =
            agent.selection.catalogEntryId === selectedAgent?.selection.catalogEntryId &&
            agent.selection.definitionRevisionId === selectedAgent?.selection.definitionRevisionId;
          const unavailable = agent.unavailableReasons.length > 0;
          const badge = agent.ownership === "system" ? t`System` : t`Personal`;
          return (
            <li key={agent.selection.catalogEntryId}>
              <button
                ref={
                  active && !unavailable
                    ? focusRefs?.selected
                    : agent.selection.catalogEntryId === firstId
                      ? focusRefs?.first
                      : undefined
                }
                type="button"
                disabled={unavailable}
                onClick={() =>
                  onSelect({ selection: agent.selection, slug: agent.slug, name: agent.name })
                }
                className={cn(
                  dropdownRowVariants({ kind: "identity", selected: active }),
                  // Pressed neutral, not an accent wash — routine selection
                  // never spends jade (same grammar as sidebar rows).
                  active && "font-medium",
                )}
              >
                <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {agent.name}
                  </span>
                  {badge ? (
                    <Badge variant="neutral" className="font-medium">
                      {badge}
                    </Badge>
                  ) : null}
                </span>
                {agents.some((other) => other !== agent && other.name === agent.name) ? (
                  <span className="text-meta text-muted-foreground">{agent.slug}</span>
                ) : null}
                {agent.description ? (
                  <span className="line-clamp-1 text-meta text-muted-foreground">
                    {agent.description}
                  </span>
                ) : null}
                {unavailable ? (
                  <span className="text-meta text-muted-foreground">
                    {agent.unavailableReasons.join(" ")}
                  </span>
                ) : null}
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
