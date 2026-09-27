/** Shared anatomy for subagent identity, state, detail, disclosure, and navigation. */
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OpenSubagentChatButton } from "../OpenSubagentChatButton";
import { Elapsed, formatSubagentElapsed, resolveSubagentName } from "./display";
import type { SubagentRun, SubagentRunStatus } from "./run-model";
import { SubagentMark } from "./SubagentMark";

export function SubagentIdentity({
  run,
  size = "row",
}: {
  run: SubagentRun;
  size?: "row" | "card";
}) {
  const name = resolveSubagentName({ agentName: run.agentName });
  const markStatus: SubagentRunStatus = run.status;
  return (
    <>
      <SubagentMark
        agentName={run.agentName}
        status={markStatus}
        className={size === "card" ? undefined : "size-5 text-[10px]"}
      />
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
      {run.description ? (
        <span className="min-w-0 truncate text-sm text-muted-foreground">{run.description}</span>
      ) : null}
      {run.startedAt ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {run.status === "running" ? (
            <Elapsed startedAt={run.startedAt} />
          ) : (
            formatSubagentElapsed(run.startedAt, run.endedAt)
          )}
        </span>
      ) : null}
    </>
  );
}

export function DisclosureChevron({
  expanded,
  className,
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <ChevronDown
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform",
        expanded && "rotate-180",
        className,
      )}
      aria-hidden
    />
  );
}

export function SubagentToolLine({
  run,
  fallback,
  className,
}: {
  run: SubagentRun;
  fallback?: ReactNode;
  className?: string;
}) {
  if (!run.liveTool && !fallback) return null;
  return (
    <div className={cn("truncate text-xs text-muted-foreground", className)}>
      {run.liveTool ?? fallback}
    </div>
  );
}

/** Row owns the left-packed identity/control layout; detail content is indented by mark + gap. */
export function SubagentRow({
  run,
  size = "row",
  expanded,
  onToggle,
  expandable = false,
  door = true,
  detail,
  children,
  className,
}: {
  run: SubagentRun;
  size?: "row" | "card";
  expanded?: boolean;
  onToggle?: () => void;
  expandable?: boolean;
  door?: boolean;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const gap = "gap-[var(--chat-space-row)]";
  const identity = <SubagentIdentity run={run} size={size} />;
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center gap-1">
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className={cn("focus-ring flex min-w-0 items-center rounded-sm text-left", gap)}
          >
            {identity}
            {<DisclosureChevron expanded={Boolean(expanded)} />}
          </button>
        ) : (
          <div className={cn("flex min-w-0 items-center", gap)}>{identity}</div>
        )}
        {door ? <OpenSubagentChatButton threadId={run.threadId} agentName={run.agentName} /> : null}
      </div>
      {detail ? (
        <div className="mt-[var(--chat-space-row)] pl-[calc(1.5rem+var(--chat-space-row))]">
          {detail}
        </div>
      ) : null}
      {expanded && children ? (
        <div className="mt-[var(--chat-space-row)] pl-[calc(1.5rem+var(--chat-space-row))]">
          {children}
        </div>
      ) : null}
    </div>
  );
}
