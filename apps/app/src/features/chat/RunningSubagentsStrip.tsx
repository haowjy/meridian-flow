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
import { ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useOpenChatThread } from "./ChatThreadNavigation";
import { SubagentMark } from "./SubagentMark";
import { ThreadStatusLabel } from "./ThreadStatusLabel";

export type RunningSubagentsStripProps = {
  /** Active descendants of the viewed thread, ordered (depth, createdAt). */
  descendants: ThreadActivityNode[];
};

export function RunningSubagentsStrip({ descendants }: RunningSubagentsStripProps) {
  const [expanded, setExpanded] = useState(false);
  const openThread = useOpenChatThread();

  if (descendants.length === 0) return null;

  const minDepth = descendants.reduce(
    (min, node) => Math.min(min, node.depth),
    Number.POSITIVE_INFINITY,
  );
  const single = descendants.length === 1 ? descendants[0] : undefined;

  return (
    <div className="border-b border-border-subtle bg-background" data-running-subagents>
      <div className="mx-auto flex w-full max-w-chat-column items-center gap-[var(--chat-space-inline)] px-6 py-1 md:px-8">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)] rounded-sm py-0.5 text-left text-caption text-ink-muted"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-ink-subtle transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          {single ? (
            <>
              <SubagentMark
                name={displayName(single)}
                status="running"
                className="size-5 text-[10px]"
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground">{displayName(single)}</span>
                {single.title && single.title !== displayName(single) ? (
                  <span className="ml-1.5 text-muted-foreground">{single.title}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {elapsed(single.runStartedAt ?? undefined)}
              </span>
            </>
          ) : (
            <>
              <span className="flex -space-x-2">
                {descendants.slice(0, 3).map((node) => (
                  <SubagentMark
                    key={node.threadId}
                    name={displayName(node)}
                    status="running"
                    className="size-5 border-background text-[10px]"
                  />
                ))}
              </span>
              <span className="truncate">
                <Trans>{descendants.length} subagents</Trans>
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                <Trans>{descendants.length} running</Trans>
              </span>
            </>
          )}
        </button>
        {single && openThread ? (
          <button
            type="button"
            aria-label={t`Open subagent chat`}
            onClick={() => openThread(single.threadId)}
            className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        ) : null}
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
      <SubagentMark name={name} status="running" className="size-5 text-[10px]" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{name}</span>
        {hint ? <span className="ml-1.5 text-ink-subtle">{hint}</span> : null}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {elapsed(node.runStartedAt ?? undefined)}
      </span>
      <ThreadStatusLabel status={node.status} className="shrink-0" />
    </>
  );

  const className = cn(
    "flex w-full items-center gap-[var(--chat-space-row)] py-1 pr-[var(--chat-card-pad-x)] text-sm",
    openThread && "focus-ring rounded-sm transition-colors hover:bg-muted",
  );
  // The 1.5rem base indent aligns with the thread-icon column; the extra rems are tree depth.
  const style = { paddingInlineStart: `calc(1.5rem + ${indent}rem)` };

  return (
    <li>
      <div className="pr-2">
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
        {node.currentTool ? (
          <div
            className="truncate pb-1 pl-[calc(1.5rem+var(--chat-space-row))] text-xs text-muted-foreground"
            style={{ paddingInlineStart: `calc(2rem + ${indent}rem)` }}
          >
            {currentToolLabel(node.currentTool.toolName, node.currentTool.input)}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function humanize(name: string): string {
  return name.replaceAll("_", " ").replace(/^./, (letter) => letter.toLocaleUpperCase());
}

function currentToolLabel(name: string, input: unknown): string {
  if (name !== "spawn") return humanize(name);
  const agent =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).agent
      : null;
  return t`Waiting on ${typeof agent === "string" && agent.trim() ? agent : t`Subagent`}`;
}

function displayName(node: ThreadActivityNode): string {
  return node.agentName?.trim() || node.title?.trim() || t`Subagent`;
}

function elapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
