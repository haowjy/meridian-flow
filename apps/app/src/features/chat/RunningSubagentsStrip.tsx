/**
 * RunningSubagentsStrip — the per-thread running direct-subagent surface.
 *
 * Anchored to the thread, not a turn, so a terminal parent turn cannot erase
 * it; fed by the server-truth `ThreadActivity` (leases + lineage). Each row
 * opens one direct child thread; all rows share the same alignment.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode, ThreadStatus } from "@meridian/contracts/threads";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useOpenChatThread } from "./ChatThreadNavigation";
import { ThreadStatusLabel } from "./ThreadStatusLabel";

export type RunningSubagentsStripProps = {
  /** The viewed thread's own derived status. */
  selfStatus: ThreadStatus;
  /** Active direct children of the viewed thread. */
  subagents: ThreadActivityNode[];
};

export function RunningSubagentsStrip({ selfStatus, subagents }: RunningSubagentsStripProps) {
  const [expanded, setExpanded] = useState(true);

  if (subagents.length === 0) return null;

  return (
    <div className="border-b border-border-subtle bg-card" data-running-subagents>
      <div className="mx-auto flex w-full max-w-chat-column items-center gap-2 px-6 py-1 md:px-8">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left text-caption text-ink-muted"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-ink-subtle transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate">
            {subagents.length === 1 ? (
              <Trans>1 subagent running</Trans>
            ) : (
              <Trans>{subagents.length} subagents running</Trans>
            )}
          </span>
        </button>
        <ThreadStatusLabel status={selfStatus} className="shrink-0" />
      </div>

      {expanded ? (
        <ul className="mx-auto w-full max-w-chat-column pb-1">
          {subagents.map((node) => (
            <SubagentRow key={node.threadId} node={node} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SubagentRow({ node }: { node: ThreadActivityNode }) {
  const openThread = useOpenChatThread();
  const name = node.agentName?.trim() || node.title?.trim() || t`Subagent`;
  const title = node.title?.trim();
  const hint = title && title !== name ? title : null;

  const body = (
    <>
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-primary">
        <LoaderCircle
          className={cn("size-3", node.status.kind === "awake" && "motion-safe:animate-spin")}
          aria-hidden
        />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{name}</span>
        {hint ? <span className="ml-1.5 text-ink-subtle">{hint}</span> : null}
      </span>
      <ThreadStatusLabel status={node.status} className="shrink-0" />
    </>
  );

  const className = cn(
    "flex w-full items-center gap-2 py-1 pr-3 text-sm",
    openThread && "focus-ring rounded-sm transition-colors hover:bg-muted",
  );
  return (
    <li>
      {openThread ? (
        <button
          type="button"
          onClick={() => openThread(node.threadId)}
          className={cn(className, "text-left")}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}
