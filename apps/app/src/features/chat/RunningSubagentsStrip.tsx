/** In-flow summary of direct background runs, with current work on expansion. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useOpenChatThread } from "./ChatThreadNavigation";
import { SubagentMark } from "./SubagentMark";
import { Elapsed, resolveSubagentName, subagentCurrentToolLabel } from "./subagent-display";

export function RunningSubagentsStrip({ descendants }: { descendants: ThreadActivityNode[] }) {
  const [expanded, setExpanded] = useState(false);
  const openThread = useOpenChatThread();
  if (!descendants.length) return null;
  const single = descendants.length === 1 ? descendants[0] : undefined;
  return (
    <section
      className="relative z-10 border-b border-border-subtle bg-background"
      data-running-subagents
    >
      <div className="mx-auto flex w-full max-w-chat-column items-center px-6 md:px-8">
        {single ? (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-caption text-ink-muted"
            >
              <SubagentMark
                agentName={single.agentName}
                status="running"
                className="size-5 text-[10px]"
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground">{resolveSubagentName(single)}</span>
                {single.title && single.title !== resolveSubagentName(single) ? (
                  <span className="ml-1.5 text-muted-foreground">{single.title}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                <Elapsed startedAt={single.runStartedAt} />
              </span>
              <ChevronRight
                className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
                aria-hidden
              />
            </button>
            {openThread ? (
              <button
                type="button"
                aria-label={t`Open subagent chat`}
                onClick={() => openThread(single.threadId)}
                className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-caption text-ink-muted"
          >
            {!expanded ? (
              <span className="flex -space-x-1.5">
                {descendants.slice(0, 3).map((node) => (
                  <span key={node.threadId} className="rounded-full bg-background p-[2px]">
                    <SubagentMark
                      agentName={node.agentName}
                      status="running"
                      className="size-5 text-[10px] after:!animate-none"
                    />
                  </span>
                ))}
              </span>
            ) : null}
            <span className="truncate">
              <Trans>{descendants.length} subagents</Trans>
            </span>
            {!expanded ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                <Trans>{descendants.length} running</Trans>
              </span>
            ) : (
              <ChevronRight className="size-3 shrink-0 rotate-90" aria-hidden />
            )}
            {!expanded ? <ChevronRight className="size-3 shrink-0" aria-hidden /> : null}
          </button>
        )}
      </div>
      {expanded && descendants.length > 1 ? (
        <ul className="mx-auto w-full max-w-chat-column px-6 pb-1 md:px-8">
          {descendants.map((node) => {
            const name = resolveSubagentName(node);
            return (
              <li key={node.threadId} className="py-1 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <SubagentMark
                    agentName={node.agentName}
                    status="running"
                    className="size-5 text-[10px]"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{name}</span>
                    {node.title && node.title !== name ? (
                      <span className="ml-1.5 text-muted-foreground">{node.title}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    <Elapsed startedAt={node.runStartedAt} />
                  </span>
                  {openThread ? (
                    <button
                      type="button"
                      aria-label={t`Open subagent chat`}
                      onClick={() => openThread(node.threadId)}
                      className="focus-ring grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted"
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
                {node.currentTool ? (
                  <p className="truncate pl-[calc(var(--chat-space-row)+1.25rem)] text-xs text-muted-foreground">
                    {subagentCurrentToolLabel(node.currentTool.toolName, node.currentTool.input)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {expanded && single?.currentTool ? (
        <p className="mx-auto w-full max-w-chat-column truncate pl-[calc(2.75rem+var(--chat-space-inline))] pb-1 text-xs text-muted-foreground">
          {subagentCurrentToolLabel(single.currentTool.toolName, single.currentTool.input)}
        </p>
      ) : null}
    </section>
  );
}
