/** Compact prospective Agent choices; the composer lists selectable catalog rows only. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import {
  dropdownResultsClass,
  dropdownRowContainerClass,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CreationAgent } from "./creation-agent";

type AgentPickerPanelProps = {
  status: AgentCatalogStatus;
  agents: AgentCatalogItem[];
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
  agents,
  selectedAgent,
  onSelect,
  focusRefs,
}: AgentPickerPanelProps) {
  const firstId = agents[0]?.selection.catalogEntryId;
  // A row's tooltip waits until the writer moves through the list: the picker
  // focuses a row as it opens, and that tooltip would cover the rows below
  // before the writer has looked at them.
  const engaged = useRef(false);
  const [tooltipRowId, setTooltipRowId] = useState<string | null>(null);
  const engage = () => {
    engaged.current = true;
  };
  return (
    <TooltipProvider delayDuration={500}>
      <div className={cn(dropdownResultsClass, "flex flex-col")}>
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
        ) : status.status === "empty" || agents.length === 0 ? (
          <PickerHint>
            <Trans>No agents available.</Trans>
          </PickerHint>
        ) : (
          <ul className="flex flex-col gap-0.5" onPointerMove={engage} onKeyDown={engage}>
            {agents.map((agent) => {
              const rowId = agent.selection.catalogEntryId;
              const active =
                agent.selection.catalogEntryId === selectedAgent?.selection.catalogEntryId &&
                agent.selection.definitionRevisionId ===
                  selectedAgent?.selection.definitionRevisionId;
              return (
                <li
                  key={agent.selection.catalogEntryId}
                  data-selected={active}
                  className={dropdownRowContainerClass}
                >
                  <Tooltip
                    open={tooltipRowId === rowId}
                    onOpenChange={(open) =>
                      setTooltipRowId((current) =>
                        open
                          ? engaged.current
                            ? rowId
                            : current
                          : current === rowId
                            ? null
                            : current,
                      )
                    }
                  >
                    <TooltipTrigger asChild>
                      <button
                        ref={
                          active
                            ? focusRefs?.selected
                            : agent.selection.catalogEntryId === firstId
                              ? focusRefs?.first
                              : undefined
                        }
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          onSelect({
                            selection: agent.selection,
                            slug: agent.slug,
                            name: agent.name,
                          })
                        }
                        className={dropdownRowVariants({ kind: "identity" })}
                      >
                        <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          <span className="max-w-1/2 truncate text-meta text-muted-foreground">
                            {agent.model ?? t`No model`}
                          </span>
                        </span>
                        {agent.description ? (
                          <span className="w-full min-w-0 truncate text-meta text-muted-foreground">
                            {agent.description}
                          </span>
                        ) : null}
                      </button>
                    </TooltipTrigger>
                    {/* Below the row, kept inside the viewport: beside it has no room on a phone. */}
                    <TooltipContent
                      side="bottom"
                      align="start"
                      collisionPadding={8}
                      className="max-w-xs space-y-1"
                    >
                      <p>
                        {agent.name}
                        {agent.model ? ` (${agent.model})` : ""}
                      </p>
                      {agent.description ? <p>{agent.description}</p> : null}
                    </TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </TooltipProvider>
  );
}

function PickerHint({ children }: { children: ReactNode }) {
  return <p className="px-3 py-4 text-sm text-muted-foreground">{children}</p>;
}
