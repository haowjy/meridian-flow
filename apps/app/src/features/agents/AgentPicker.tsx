/** Compact prospective Agent choices; the composer lists selectable catalog rows only. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type RefObject, useRef, useState } from "react";
import type { AgentCatalogStatus } from "@/client/query/useAgentCatalog";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Chip } from "@/components/ui/chip";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerResults, PickerSection } from "@/components/ui/picker";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { hidesSentence, levelLabel } from "./AgentFileNotice";
import type { CreationAgent, PickableAgent } from "./creation-agent";

type AgentPickerPanelProps = {
  status: AgentCatalogStatus;
  agents: PickableAgent[];
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
  const firstId = agents[0]?.selection.slug;
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
      <Picker>
        <PickerResults>
          {status.status === "loading" || status.status === "disabled" ? (
            <ListLine density="menu" status>
              <Trans>Loading agents…</Trans>
            </ListLine>
          ) : status.status === "error" ? (
            <InlineErrorRow
              message={t`Couldn't load agents.`}
              onRetry={status.refetch}
              retryRef={focusRefs?.retry}
            />
          ) : status.status === "empty" || agents.length === 0 ? (
            <ListLine density="menu">
              <Trans>No agents available.</Trans>
            </ListLine>
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: only notes that the writer has moved through the list. slop-lint: allow suppression the reason is stated in this comment
            <div onPointerMove={engage} onKeyDown={engage}>
              <PickerSection>
                {agents.map((agent) => {
                  const rowId = agent.selection.slug;
                  const active = rowId === selectedAgent?.selection.slug;
                  return (
                    <li key={rowId}>
                      <ListRow
                        density="menu"
                        current={active}
                        ref={
                          active
                            ? focusRefs?.selected
                            : rowId === firstId
                              ? focusRefs?.first
                              : undefined
                        }
                        onOpen={() =>
                          onSelect({
                            selection: agent.selection,
                            slug: agent.slug,
                            name: agent.name,
                          })
                        }
                        title={agent.name}
                        meta={
                          // The level, only where a writer could wonder which one this is.
                          agent.shadows.length > 0 ? (
                            <>
                              <Chip kind="label" className="mr-1.5">
                                {levelLabel(agent.level)}
                              </Chip>
                              {agent.model ?? t`No model`}
                            </>
                          ) : (
                            (agent.model ?? t`No model`)
                          )
                        }
                        detail={agent.description}
                        wrapControl={(button) => (
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
                            <TooltipTrigger asChild>{button}</TooltipTrigger>
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
                              {agent.shadows.length > 0 ? (
                                <p>{hidesSentence(agent.level, agent.shadows)}</p>
                              ) : null}
                              {agent.description ? <p>{agent.description}</p> : null}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      />
                    </li>
                  );
                })}
              </PickerSection>
            </div>
          )}
        </PickerResults>
      </Picker>
    </TooltipProvider>
  );
}
