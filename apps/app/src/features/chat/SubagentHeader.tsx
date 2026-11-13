/** Subagent directory action for the chat pane tab row: every helper this chat started. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { Network } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerResults, PickerSearch, PickerSection } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useRequestConversationReveal } from "./conversation-reveal";
import { OpenSubagentChatButton } from "./OpenSubagentChatButton";
import {
  Elapsed,
  formatSubagentElapsed,
  subagentMarkName,
  subagentStatus,
} from "./subagent/display";
import { runFromActivity, type SubagentRun } from "./subagent/run-model";
import { SubagentMark } from "./subagent/SubagentMark";
import { matchesSubagentIdentity } from "./subagent/SubagentRow";

type Entry = { node: ThreadActivityNode; run: SubagentRun };

export function SubagentHeader({
  threadId,
  nodes,
}: {
  threadId: string;
  nodes: ThreadActivityNode[];
}) {
  const requestConversationReveal = useRequestConversationReveal();
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const contentRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const entries = useMemo(
    () =>
      [...nodes]
        .sort(
          (a, b) =>
            Number(b.status.kind === "awake") - Number(a.status.kind === "awake") ||
            Date.parse(b.runEndedAt ?? "") - Date.parse(a.runEndedAt ?? ""),
        )
        .map(
          (node): Entry => ({
            node,
            run: {
              ...runFromActivity(node),
              status: subagentStatus(node.spawnStatus, node.status.kind === "awake"),
            },
          }),
        ),
    [nodes],
  );
  if (!entries.length) return null;
  const search = filter.trim();
  const visible = entries.filter(({ run }) => matchesSubagentIdentity(run, search));
  const running = visible.filter(({ run }) => run.status === "running");
  const finished = visible.filter(({ run }) => run.status !== "running");
  const anyRunning = entries.some(({ run }) => run.status === "running");
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setFilter("");
  };
  const show = (node: ThreadActivityNode) => {
    if (!node.originTurnId) return;
    requestConversationReveal({
      kind: "turn",
      threadId,
      turnId: node.originTurnId,
      subagentThreadId: node.threadId,
    });
    changeOpen(false);
  };
  const row = ({ node, run }: Entry) => (
    <li key={node.threadId}>
      <ListRow
        density="menu"
        leading={<SubagentMark agentName={run.agentName} status={run.status} className="size-5" />}
        title={run.name ?? subagentMarkName(run.agentName)}
        meta={
          <>
            {run.name ? (
              <span className="font-medium">{subagentMarkName(run.agentName)} </span>
            ) : null}
            {run.status === "running" ? (
              <Elapsed startedAt={run.startedAt} />
            ) : (
              formatSubagentElapsed(run.startedAt, run.endedAt)
            )}
          </>
        }
        detail={run.status === "running" ? run.liveTool : null}
        disabled={!node.originTurnId}
        onOpen={() => show(node)}
        actions={
          <OpenSubagentChatButton
            threadId={node.threadId}
            agentName={run.agentName}
            onOpened={() => changeOpen(false)}
          />
        }
      />
    </li>
  );
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t`Subagents, ${nodes.length}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-ink-fill hover:text-foreground popup-open:bg-ink-fill-strong popup-open:text-foreground coarse:min-h-11"
        >
          <Network className="size-3.5" aria-hidden />
          <span aria-hidden="true">{nodes.length}</span>
          {anyRunning ? (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        ref={contentRef}
        align="end"
        className={cn(
          dropdownSurfaceVariants({ measure: "catalog" }),
          "text-tier-chat w-[min(26rem,calc(100vw-1.5rem))]",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>("input, [data-list-item]")?.focus();
        }}
      >
        <Picker label={t`Subagents`}>
          <PickerSearch value={filter} onChange={setFilter} label={t`Filter subagents`} />
          <PickerResults>
            {visible.length === 0 ? (
              <ListLine density="menu">
                <Trans>No subagents match “{search}”.</Trans>
              </ListLine>
            ) : null}
            {running.length ? (
              <PickerSection label={t`Running`}>{running.map(row)}</PickerSection>
            ) : null}
            {finished.length ? (
              <PickerSection label={t`Finished`}>{finished.map(row)}</PickerSection>
            ) : null}
          </PickerResults>
        </Picker>
      </PopoverContent>
    </Popover>
  );
}
