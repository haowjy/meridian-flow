/**
 * RunningSubagentsStrip — the per-thread, recursive running-subagent surface.
 *
 * Anchored to the thread, not a turn, so a terminal parent turn cannot erase
 * it; fed by the server-truth `ThreadActivity` (leases + lineage). One surface
 * per viewed thread: a child shows its own children with no primary special
 * case. Each row opens that child thread; rows indent by spawn depth.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useOpenChatThread } from "./ChatThreadNavigation";

export type RunningSubagentsStripProps = {
  /** Active descendants of the viewed thread, ordered (depth, createdAt). */
  descendants: ThreadActivityNode[];
};

export function RunningSubagentsStrip({ descendants }: RunningSubagentsStripProps) {
  const [expanded, setExpanded] = useState(true);

  if (descendants.length === 0) return null;

  const minDepth = descendants.reduce(
    (min, node) => Math.min(min, node.depth),
    Number.POSITIVE_INFINITY,
  );

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
            {descendants.length === 1 ? (
              <Trans>1 subagent running</Trans>
            ) : (
              <Trans>{descendants.length} subagents running</Trans>
            )}
          </span>
        </button>
      </div>

      {expanded ? (
        <ul className="mx-auto w-full max-w-chat-column pb-1">
          {descendants.map((node) => (
            <SubagentRow
              key={node.threadId}
              node={node}
              indent={Number.isFinite(minDepth) ? node.depth - minDepth : 0}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SubagentRow({ node, indent }: { node: ThreadActivityNode; indent: number }) {
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
    </>
  );

  const className = cn(
    "flex w-full items-center gap-2 py-1 pr-3 text-sm",
    openThread && "focus-ring rounded-sm transition-colors hover:bg-muted",
  );
  const style = { paddingInlineStart: `calc(1.5rem + ${indent}rem)` };

  return (
    <li>
      {openThread ? (
        <button
          type="button"
          onClick={() => openThread(node.threadId)}
          className={cn(className, "text-left")}
          style={style}
        >
          {body}
        </button>
      ) : (
        <div className={className} style={style}>
          {body}
        </div>
      )}
    </li>
  );
}
