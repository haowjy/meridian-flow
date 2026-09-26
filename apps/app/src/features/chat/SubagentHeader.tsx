/** Subagent directory action for the chat pane tab row. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { ChevronDown, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
    if (node.originTurnId)
      requestConversationReveal({
        kind: "turn",
        threadId,
        turnId: node.originTurnId,
        subagentThreadId: node.threadId,
      });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          className="focus-ring inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Users className="size-3.5" aria-hidden />
          <span>
            <Trans>Subagents</Trans> {nodes.length}
          </span>
          {running.length ? (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          ) : null}
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(70vh,30rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto p-2"
      >
        <label className="sr-only" htmlFor="subagent-filter">
          <Trans>Filter subagents</Trans>
        </label>
        <input
          id="subagent-filter"
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
                <li
                  key={node.threadId}
                  className="flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted"
                >
                  <SubagentMark
                    name={resolveSubagentName(node)}
                    status={subagentStatus(undefined, true)}
                    className="size-5 text-[10px]"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {resolveSubagentName(node)}
                    {node.title && node.title !== resolveSubagentName(node) ? (
                      <span className="ml-1 text-muted-foreground">{node.title}</span>
                    ) : null}
                    {node.currentTool ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {subagentCurrentToolLabel(
                          node.currentTool.toolName,
                          node.currentTool.input,
                        )}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => show(node)}
                    className="focus-ring rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Trans>Show</Trans>
                  </button>
                  {openThread ? (
                    <button
                      type="button"
                      onClick={() => openThread(node.threadId)}
                      className="focus-ring rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Trans>Open</Trans>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {finished.length ? (
          <>
            <h3 className="mt-1 px-2 py-1 text-xs font-medium text-muted-foreground">
              <Trans>Finished</Trans>
            </h3>
            <ul>
              {finished.map((node) => (
                <li
                  key={node.threadId}
                  className="flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted"
                >
                  <SubagentMark
                    name={resolveSubagentName(node)}
                    status={subagentStatus(node.spawnStatus)}
                    className="size-5 text-[10px]"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {resolveSubagentName(node)}
                    {node.title && node.title !== resolveSubagentName(node) ? (
                      <span className="ml-1 text-muted-foreground">{node.title}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => show(node)}
                    className="focus-ring rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Trans>Show</Trans>
                  </button>
                  {openThread ? (
                    <button
                      type="button"
                      onClick={() => openThread(node.threadId)}
                      className="focus-ring rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Trans>Open</Trans>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
