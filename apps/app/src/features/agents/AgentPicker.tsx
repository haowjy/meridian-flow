/** Compact prospective Agent choices; Project removal leaves source and bound chats intact. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { type AgentCatalogStatus, useRemoveProjectAgent } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  dropdownResultsVariants,
  dropdownRowContainerClass,
  dropdownRowVariants,
} from "@/components/ui/dropdown-presentation";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DEFAULT_AGENT_SLUG } from "./constants";
import type { CreationAgent } from "./creation-agent";

type AgentPickerPanelProps = {
  status: AgentCatalogStatus;
  selectedAgent: CreationAgent | null;
  onSelect: (agent: CreationAgent) => void;
  projectId?: string;
  focusRefs?: {
    selected: RefObject<HTMLButtonElement | null>;
    first: RefObject<HTMLButtonElement | null>;
    retry: RefObject<HTMLButtonElement | null>;
  };
};

export function AgentPickerPanel(props: AgentPickerPanelProps) {
  return props.projectId ? (
    <ProjectAgentPicker {...props} projectId={props.projectId} />
  ) : (
    <PickerChoices {...props} />
  );
}

function ProjectAgentPicker(props: AgentPickerPanelProps & { projectId: string }) {
  const removal = useRemoveProjectAgent(props.projectId);
  return (
    <>
      <PickerChoices
        {...props}
        pending={removal.isPending}
        onRemove={(agent) => removal.mutate(agent.selection)}
      />
      {removal.isError ? (
        <InlineErrorRow
          message={t`Couldn't remove agent from project.`}
          onRetry={() => removal.mutate(removal.variables)}
        />
      ) : null}
    </>
  );
}

function PickerChoices({
  status,
  selectedAgent,
  onSelect,
  focusRefs,
  onRemove,
  pending = false,
}: AgentPickerPanelProps & { onRemove?: (agent: AgentCatalogItem) => void; pending?: boolean }) {
  const agents = status.agents ?? [];
  const firstId = agents[0]?.selection.catalogEntryId;
  return (
    <TooltipProvider delayDuration={500}>
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
          <ul className="flex flex-col gap-0.5">
            {agents.map((agent) => {
              const active =
                agent.selection.catalogEntryId === selectedAgent?.selection.catalogEntryId &&
                agent.selection.definitionRevisionId ===
                  selectedAgent?.selection.definitionRevisionId;
              const unavailable = agent.unavailableReasons.length > 0;
              const general = agent.ownership === "system" && agent.slug === DEFAULT_AGENT_SLUG;
              return (
                <li
                  key={agent.selection.catalogEntryId}
                  data-selected={active}
                  className={cn(dropdownRowContainerClass, "flex items-center")}
                >
                  <Tooltip>
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
                        aria-disabled={unavailable || pending}
                        aria-pressed={active}
                        onClick={() => {
                          if (!unavailable && !pending)
                            onSelect({
                              selection: agent.selection,
                              slug: agent.slug,
                              name: agent.name,
                            });
                        }}
                        className={cn(
                          dropdownRowVariants({ kind: "identity" }),
                          "flex-1",
                          unavailable && "text-muted-foreground",
                        )}
                      >
                        <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          <span className="max-w-1/2 truncate text-meta text-muted-foreground">
                            {agent.model ?? t`No model`}
                          </span>
                        </span>
                        <span className="flex w-full min-w-0 gap-2 text-meta text-muted-foreground">
                          {agent.description ? (
                            <span className="min-w-0 flex-1 truncate">{agent.description}</span>
                          ) : null}
                          {unavailable ? (
                            <span className="shrink-0">
                              <Trans>Unavailable</Trans>
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-xs space-y-1">
                      <p>
                        {agent.name}
                        {agent.model ? ` (${agent.model})` : ""}
                      </p>
                      {agent.description ? <p>{agent.description}</p> : null}
                      {agent.unavailableReasons.map((reason) => (
                        <p key={reason}>{reason}</p>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                  {onRemove && !general ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-muted-foreground"
                          disabled={pending}
                          aria-label={t`Remove ${agent.name} from project`}
                          onClick={() => onRemove(agent)}
                        >
                          <X />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <Trans>Remove from project</Trans>
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
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
