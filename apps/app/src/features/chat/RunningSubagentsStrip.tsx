/** In-flow summary of direct background runs, with current work on expansion and a Stop per run. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ChatReferenceScope } from "@meridian/thread-client";
import { Square } from "lucide-react";
import type { ComponentProps } from "react";
import { FailureCard } from "@/components/app/FailureCard";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { chatCardText } from "./chat-card-copy";
import { useSubagentRuns } from "./subagent/ActivityContext";
import { useSubagentDisclosure } from "./subagent/DisclosureStore";
import { subagentMarkName } from "./subagent/display";
import type { SubagentRun } from "./subagent/run-model";
import { SubagentIdentity, SubagentRow, SubagentToolLine } from "./subagent/SubagentRow";
import { useSubagentStop } from "./subagent/useSubagentStop";

/** Where a child's handed-back messages resolve: the parent's lineage, Work and top chat. */
type StopContext = { accountId: string; scope: ChatReferenceScope | null };
type RunningRun = SubagentRun & { threadId: string };

export function RunningSubagentsStrip({
  threadId,
  ...stopContext
}: { threadId: string } & StopContext) {
  const children = useSubagentRuns().filter(
    (run): run is RunningRun =>
      run.threadId !== null &&
      run.deliveryMode === "background_notification" &&
      run.status === "running",
  );
  const [expanded, setExpanded] = useSubagentDisclosure(`panel:${threadId}`);
  if (!children.length) return null;
  const first = children[0];
  if (!first) return null;
  const aggregate = { ...first, agentName: "Subagent", name: null };
  const single = children.length === 1 ? children[0] : undefined;
  return (
    <section
      className="relative z-10 border-b border-border-subtle bg-background"
      data-running-subagents
    >
      <div className="mx-auto w-full max-w-chat-column px-6 md:px-8">
        {single ? (
          <RunningSubagentRow
            key={single.threadId}
            run={single}
            stopContext={stopContext}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            expandable
            className="py-1 text-caption text-ink-muted"
          >
            <SubagentToolLine run={single} />
          </RunningSubagentRow>
        ) : (
          <SubagentRow
            run={first}
            identity={
              <>
                <SubagentIdentity
                  run={aggregate}
                  showName={false}
                  agentLabel={<Trans>{children.length} subagents</Trans>}
                />
                <span className="truncate text-xs text-muted-foreground">
                  <Trans>{children.length} running</Trans>
                </span>
              </>
            }
            door={false}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            expandable
            className="py-1 text-caption text-ink-muted"
          >
            <ul className="pb-1">
              {children.map((run) => (
                <li key={run.threadId} className="py-1 text-caption text-ink-muted">
                  <RunningSubagentRow run={run} stopContext={stopContext} />
                  <SubagentToolLine run={run} className="pb-1 pl-7" />
                </li>
              ))}
            </ul>
          </SubagentRow>
        )}
      </div>
    </section>
  );
}

/** One running child: its row, its Stop, and the card a failed Stop owes it. */
function RunningSubagentRow({
  run,
  stopContext,
  ...row
}: { run: RunningRun; stopContext: StopContext } & Omit<
  ComponentProps<typeof SubagentRow>,
  "run" | "trailing" | "detail"
>) {
  const { status, cards, stop, act } = useSubagentStop({
    threadId: run.threadId,
    ...stopContext,
  });
  // The task name tells sibling rows apart; every child may share one agent name.
  const name = run.name ?? subagentMarkName(run.agentName);
  const stopping = status === "pending" || status === "stopping";
  return (
    <SubagentRow
      run={run}
      {...row}
      trailing={
        // A failed Stop's card carries Try again in Stop's place.
        cards.length === 0 ? (
          <IconButton
            type="button"
            size="sm"
            tooltip={stopping ? t`Stopping "${name}"` : t`Stop "${name}"`}
            // aria-disabled, not disabled: disabling the focused button would drop focus.
            aria-disabled={stopping || undefined}
            data-subagent-stop={status}
            onClick={(event) => {
              event.stopPropagation();
              stop();
            }}
            className="relative size-7"
          >
            <Square className="size-2.5 fill-current" aria-hidden />
            {stopping ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0.5 rounded-full border-2 border-current/25 border-t-current motion-safe:animate-spin"
              />
            ) : null}
          </IconButton>
        ) : null
      }
      detail={
        cards.length > 0
          ? cards.map((card) => (
              <FailureCard
                key={card.key}
                tone="error"
                inline
                onDismiss={card.action === "dismiss" ? () => act(card) : undefined}
              >
                <p data-chat-card={card.copy} data-failure-id={card.key}>
                  {chatCardText(card)}
                </p>
                {card.action === "try_again" ? (
                  <Button type="button" variant="outline" size="xs" onClick={() => act(card)}>
                    <Trans>Try again</Trans>
                  </Button>
                ) : null}
              </FailureCard>
            ))
          : null
      }
    />
  );
}
