/** Quiet inline rows for child completion and delivery events. */
import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import type { DeliveryEvent, DeliveryGroup } from "@meridian/thread-client";
import { MessageSquareText } from "lucide-react";
import { ActivityRow } from "../ActivityRow";
import { useSubagentDisclosure } from "./DisclosureStore";
import { subagentStatus } from "./display";
import type { SubagentRun } from "./run-model";
import { SubagentIdentity, SubagentRow } from "./SubagentRow";

/** Draws the view model's delivery groups: a group of several is one merged row. */
export function DeliveryEventRows({ groups }: { groups: readonly DeliveryGroup[] }) {
  return (
    <>
      {groups.map((group) => (
        <DeliveryGroupRow key={group.id} group={group} />
      ))}
    </>
  );
}

function DeliveryGroupRow({ group }: { group: DeliveryGroup }) {
  const { events } = group;
  const [expanded, setExpanded] = useSubagentDisclosure(`delivery:${group.id}`);
  const only = events[0];
  if (events.length === 1 && only) return <DeliveryEventRow {...only} />;
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
      showName={false}
      agentLabel={<span className="truncate font-medium text-foreground">{summary}</span>}
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
    const sender = event.sender;
    const senderName = sender
      ? sender.title?.trim()
        ? sender.ref
          ? `${sender.title.trim()} (${sender.ref})`
          : sender.title.trim()
        : sender.ref
      : null;
    return (
      <ActivityRow Icon={MessageSquareText}>
        <span className="whitespace-pre-wrap text-foreground">
          {senderName ? <Trans>From {senderName}: </Trans> : null}
          {event.message || <Trans>Shared an attachment</Trans>}
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
    name: event.title?.trim() || null,
    status: subagentStatus(outcome),
    startedAt: null,
    endedAt: event.turn.completedAt ?? null,
    liveTool: null,
    originTurnId: null,
    parentThreadId: event.turn.threadId,
    deliveryMode: null,
  };
}
