/** In-flow summary of direct background runs, with current work on expansion. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { type OpenChatThread, useOpenChatThread } from "./ChatThreadNavigation";
import { SubagentMark } from "./SubagentMark";
import { Elapsed, resolveSubagentName, subagentCurrentToolLabel } from "./subagent-display";

// Tool lines sit under the name: mark (size-5) plus the row gap (gap-2).
const TOOL_LINE_INDENT = "pl-7";

export function RunningSubagentsStrip({ descendants }: { descendants: ThreadActivityNode[] }) {
  const [expanded, setExpanded] = useState(false);
  const openThread = useOpenChatThread();
  if (!descendants.length) return null;
  const single = descendants.length === 1 ? descendants[0] : undefined;
  const disclosure = (
    <ChevronDown
      className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
      aria-hidden
    />
  );
  return (
    <section
      className="relative z-10 border-b border-border-subtle bg-background"
      data-running-subagents
    >
      <div className="mx-auto w-full max-w-chat-column px-6 md:px-8">
        {single ? (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
                className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-caption text-ink-muted"
              >
                <RunIdentity node={single} />
                {disclosure}
              </button>
              <OpenButton node={single} openThread={openThread} />
            </div>
            {expanded ? <ToolLine node={single} /> : null}
          </>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className="focus-ring flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-caption text-ink-muted"
            >
              {!expanded ? (
                <span className="flex -space-x-1.5">
                  {descendants.slice(0, 3).map((node) => (
                    <span key={node.threadId} className="rounded-full bg-background p-[2px]">
                      <SubagentMark
                        agentName={node.agentName}
                        status="running"
                        className="size-5 text-[10px] after:!animate-none"
                        decorative
                      />
                    </span>
                  ))}
                </span>
              ) : null}
              <span className="truncate font-medium text-foreground">
                <Trans>{descendants.length} subagents</Trans>
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {!expanded ? <Trans>{descendants.length} running</Trans> : null}
              </span>
              {disclosure}
            </button>
            {expanded ? (
              <ul className="pb-1">
                {descendants.map((node) => (
                  <li key={node.threadId} className="text-caption text-ink-muted">
                    <div className="flex min-w-0 items-center gap-1 py-1">
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <RunIdentity node={node} />
                      </span>
                      <OpenButton node={node} openThread={openThread} />
                    </div>
                    <ToolLine node={node} />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function RunIdentity({ node }: { node: ThreadActivityNode }) {
  const name = resolveSubagentName(node);
  return (
    <>
      <SubagentMark agentName={node.agentName} status="running" className="size-5 text-[10px]" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{name}</span>
        {node.title && node.title !== name ? (
          <span className="ml-1.5 text-muted-foreground">{node.title}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        <Elapsed startedAt={node.runStartedAt} />
      </span>
    </>
  );
}

function OpenButton({
  node,
  openThread,
}: {
  node: ThreadActivityNode;
  openThread: OpenChatThread | null;
}) {
  if (!openThread) return null;
  return (
    <button
      type="button"
      aria-label={t`Open subagent chat`}
      title={t`Open subagent chat`}
      onClick={() => openThread(node.threadId)}
      className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <ChevronRight className="size-4" aria-hidden />
    </button>
  );
}

function ToolLine({ node }: { node: ThreadActivityNode }) {
  if (!node.currentTool) return null;
  return (
    <p className={cn("truncate pb-1 text-xs text-muted-foreground", TOOL_LINE_INDENT)}>
      {subagentCurrentToolLabel(node.currentTool.toolName, node.currentTool.input)}
    </p>
  );
}
