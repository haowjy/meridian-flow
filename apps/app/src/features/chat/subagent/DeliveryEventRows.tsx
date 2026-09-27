/** Quiet inline rows for child completion and delivery events. */
import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import type { Block, Turn } from "@meridian/contracts/protocol";
import { MessageSquareText } from "lucide-react";
import { ActivityRow } from "../ActivityRow";
import { useSubagentDisclosure } from "./DisclosureStore";
import { subagentStatus } from "./display";
import type { SubagentRun } from "./run-model";
import { SubagentIdentity, SubagentRow } from "./SubagentRow";
import type { SubagentUpdateMetadata } from "./update";
import { groupAdjacentSubagentUpdates } from "./update";

export type DeliveryEvent = {
  turn: Turn;
  childThreadId?: string;
  title?: string;
  subagentUpdate: SubagentUpdateMetadata | null;
};

export function DeliveryEventRows({ events }: { events: DeliveryEvent[] }) {
  const groups = groupAdjacentSubagentUpdates(events);
  return (
    <>
      {groups.map((group) =>
        group.length > 1 ? (
          <MergedCompletionRow key={group.map((event) => event.turn.id).join(":")} events={group} />
        ) : group[0] ? (
          <DeliveryEventRow key={group[0].turn.id} {...group[0]} />
        ) : null,
      )}
    </>
  );
}

function MergedCompletionRow({ events }: { events: DeliveryEvent[] }) {
  const entries = events.map((event) => {
    const update = event.subagentUpdate;
    const run = deliveryRun(event);
    return { event, run, name: run.agentName || "Subagent", outcome: update?.outcome };
  });
  const first = entries[0];
  if (!first) return null;
  const names = entries.map(({ name }) => name);
  const stopped = entries.filter(({ outcome }) => outcome === "failed" || outcome === "cancelled");
  const list = (values: string[]) =>
    new Intl.ListFormat(i18n.locale, { style: "long", type: "conjunction" }).format(values);
  const childIds = entries.flatMap(({ run }) => (run.threadId ? [run.threadId] : []));
  const key = `merged:${events.map((event) => event.turn.id).join(":")}`;
  const [expanded, setExpanded] = useSubagentDisclosure(key);
  const summary =
    names.length > 3 || new Set(names).size < names.length ? (
      stopped.length ? (
        <Trans>
          {names.length} subagents finished ({stopped.length} stopped)
        </Trans>
      ) : (
        <Trans>{names.length} subagents finished</Trans>
      )
    ) : stopped.length === 0 ? (
      <Trans>{list(names)} finished</Trans>
    ) : stopped.length === entries.length ? (
      <Trans>{list(names)} stopped</Trans>
    ) : (
      <Trans>
        {list(
          entries.map(
            ({ name, outcome }) =>
              `${name} ${outcome === "succeeded" ? i18n._("finished") : i18n._("stopped")}`,
          ),
        )}
      </Trans>
    );
  const header = (
    <SubagentIdentity
      run={first.run}
      showDescription={false}
      name={<span className="truncate font-medium text-foreground">{summary}</span>}
    />
  );
  return (
    <div className="min-w-0 text-sm text-muted-foreground" data-subagent-finished>
      <SubagentRow
        run={first.run}
        identity={header}
        threadIds={childIds.join(" ")}
        door={false}
        expandable
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        <div
          className="space-y-1 border-l border-border-subtle py-1 pl-3"
          data-subagent-thread-ids={childIds.join(" ")}
        >
          {entries.map(({ run, name }, index) => (
            <div
              key={`${run.threadId ?? name}-${index}`}
              data-subagent-thread-id={run.threadId ?? undefined}
            >
              <SubagentRow run={run} />
            </div>
          ))}
        </div>
      </SubagentRow>
    </div>
  );
}

function DeliveryEventRow(event: DeliveryEvent) {
  if (!event.subagentUpdate) {
    const body = event.turn.blocks
      .filter((block: Block) => block.blockType === "text")
      .map((block) => block.textContent ?? "")
      .join("");
    return (
      <ActivityRow Icon={MessageSquareText}>
        <span className="whitespace-pre-wrap text-foreground">
          {body || <Trans>Shared an attachment</Trans>}
        </span>
      </ActivityRow>
    );
  }
  const run = deliveryRun(event);
  const completed = event.subagentUpdate.outcome === "succeeded";
  return (
    <div
      className="min-w-0 text-sm text-muted-foreground"
      data-subagent-finished
      data-subagent-thread-id={run.threadId ?? undefined}
    >
      <SubagentRow
        run={run}
        identity={
          <SubagentIdentity
            run={run}
            afterName={
              <span className="min-w-0 truncate py-[var(--chat-space-row)] text-sm text-muted-foreground">
                {completed ? <Trans>finished</Trans> : <Trans>stopped</Trans>}
              </span>
            }
          />
        }
      />
    </div>
  );
}

function deliveryRun(event: DeliveryEvent): SubagentRun {
  const update = event.subagentUpdate;
  const outcome = update?.outcome;
  return {
    threadId: update?.childThreadId ?? event.childThreadId ?? null,
    ref: update?.handle ?? null,
    execution: update?.execution ?? null,
    agentName: update?.agentName?.trim() || "Subagent",
    description: event.title?.trim() || null,
    status: subagentStatus(outcome),
    startedAt: null,
    endedAt: event.turn.completedAt ?? null,
    liveTool: null,
    originTurnId: null,
    parentThreadId: event.turn.threadId,
    deliveryMode: null,
  };
}
