/** Subagent directory action for the chat pane tab row. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { ExternalLink, LocateFixed, Network } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { requestConversationReveal } from "./conversation-reveal";
import { SubagentMark } from "./SubagentMark";
import { resolveSubagentName, subagentCurrentToolLabel, subagentStatus } from "./subagent-display";

export function SubagentHeader({
  threadId,
  nodes,
  openThread,
}: {
  threadId: string;
  nodes: ThreadActivityNode[];
  openThread: (threadId: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const [open, setOpen] = useState(false);
  const ordered = useMemo(
    () =>
      [...nodes].sort(
        (a, b) =>
          Number(b.status.kind === "awake") - Number(a.status.kind === "awake") ||
          Date.parse(b.runEndedAt ?? "") - Date.parse(a.runEndedAt ?? ""),
      ),
    [nodes],
  );
  const visible = ordered.filter((node) =>
    `${resolveSubagentName(node)} ${node.title ?? ""}`
      .toLocaleLowerCase()
      .includes(filter.toLocaleLowerCase()),
  );
  if (!nodes.length) return null;
  const running = nodes.filter((node) => node.status.kind === "awake");
  const finished = visible.filter((node) => node.status.kind !== "awake");
  const active = visible.filter((node) => node.status.kind === "awake");
  const show = (node: ThreadActivityNode) => {
    if (node.originTurnId) {
      requestConversationReveal({
        kind: "turn",
        threadId,
        turnId: node.originTurnId,
        subagentThreadId: node.threadId,
      });
      setOpen(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t`Subagents, ${nodes.length}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="focus-ring inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Network className="size-3.5" aria-hidden />
          <span aria-hidden="true">{nodes.length}</span>
          {running.length ? (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(70vh,30rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto bg-background p-2"
      >
        <label className="sr-only" htmlFor={filterId}>
          <Trans>Filter subagents</Trans>
        </label>
        <input
          id={filterId}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t`Filter subagents`}
          className="focus-ring mb-2 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        />
        {active.length ? (
          <>
            <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
              <Trans>Running</Trans>
            </h3>
            <ul>
              {active.map((node) => (
                <SubagentPopoverRow
                  key={node.threadId}
                  node={node}
                  onShow={show}
                  openThread={openThread}
                />
              ))}
            </ul>
          </>
        ) : null}
        {finished.length ? (
          <>
            <h3 className="mt-[var(--chat-space-row)] px-2 py-1 text-xs font-medium text-muted-foreground">
              <Trans>Finished</Trans>
            </h3>
            <ul>
              {finished.map((node) => (
                <SubagentPopoverRow
                  key={node.threadId}
                  node={node}
                  onShow={show}
                  openThread={openThread}
                />
              ))}
            </ul>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SubagentPopoverRow({
  node,
  onShow,
  openThread,
}: {
  node: ThreadActivityNode;
  onShow: (node: ThreadActivityNode) => void;
  openThread: (threadId: string) => void;
}) {
  const name = resolveSubagentName(node);
  const running = node.status.kind === "awake";
  return (
    <li className="flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
      <SubagentMark
        agentName={node.agentName}
        status={subagentStatus(node.spawnStatus, running)}
        className="size-5 text-[10px]"
      />
      <span className="min-w-0 flex-1 truncate">
        {name}
        {node.title && node.title !== name ? (
          <span className="ml-1 text-muted-foreground">{node.title}</span>
        ) : null}
        {running && node.currentTool ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subagentCurrentToolLabel(node.currentTool.toolName, node.currentTool.input)}
          </span>
        ) : null}
      </span>
      {node.originTurnId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t`Jump to in chat`}
              onClick={() => onShow(node)}
              className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LocateFixed className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t`Jump to in chat`}</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t`Open subagent chat`}
            onClick={() => openThread(node.threadId)}
            className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t`Open subagent chat`}</TooltipContent>
      </Tooltip>
    </li>
  );
}
