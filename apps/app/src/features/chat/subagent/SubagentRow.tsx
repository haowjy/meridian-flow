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
  agentLabel,
  showName = true,
  afterName,
}: {
  run: SubagentRun;
  size?: "row" | "card";
  /** Replaces the agent name, e.g. an aggregate count. */
  agentLabel?: ReactNode;
  /** Whether the run's task name follows the agent name. */
  showName?: boolean;
  afterName?: ReactNode;
}) {
  const markStatus: SubagentRunStatus = run.status;
  return (
    <>
      <SubagentMark
        agentName={run.agentName}
        status={markStatus}
        className={size === "card" ? undefined : "size-5 text-[10px]"}
      />
      {agentLabel ?? <SubagentIdentityName run={run} />}
      {showName && run.name ? (
        <span
          className={cn(
            "min-w-0 truncate text-sm text-muted-foreground",
            size === "card" && "flex-1",
          )}
        >
          {run.name}
        </span>
      ) : null}
      {afterName}
      {run.startedAt ? (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums text-muted-foreground",
            size === "card" && "ml-auto",
          )}
        >
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

export function SubagentIdentityName({ run }: { run: SubagentRun }) {
  return (
    // The agent name is the identity: the task name gives way first, and the agent name
    // truncates only past half the row.
    <span className="max-w-[50%] shrink-0 truncate text-sm font-medium text-foreground">
      {resolveSubagentName({ agentName: run.agentName })}
    </span>
  );
}

export function matchesSubagentIdentity(run: SubagentRun, filter: string): boolean {
  return `${run.agentName} ${run.name ?? ""}`
    .toLocaleLowerCase()
    .includes(filter.toLocaleLowerCase());
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

/**
 * Row owns the identity/control layout; detail content is indented by mark + gap.
 * Bare rows pack controls against the text. A card's border binds its controls
 * to the row, so a card row spans its width and ends in them.
 */
export function SubagentRow({
  run,
  identity: identityOverride,
  size = "row",
  expanded,
  onToggle,
  onActivate,
  activateLabel,
  onOpened,
  expandable = false,
  door = true,
  threadIds,
  detail,
  children,
  className,
}: {
  run: SubagentRun;
  /** Specialized writer-facing copy can replace the standard name/detail identity. */
  identity?: ReactNode;
  size?: "row" | "card";
  expanded?: boolean;
  onToggle?: () => void;
  onActivate?: () => void;
  activateLabel?: string;
  onOpened?: () => void;
  expandable?: boolean;
  door?: boolean;
  threadIds?: string;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const gap = "gap-[var(--chat-space-row)]";
  const fill = size === "card" && "flex-1";
  const identity = identityOverride ?? <SubagentIdentity run={run} size={size} />;
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center gap-1">
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            data-subagent-thread-ids={threadIds}
            onClick={onToggle}
            className={cn("focus-ring flex min-w-0 items-center rounded-sm text-left", gap, fill)}
          >
            {identity}
            {<DisclosureChevron expanded={Boolean(expanded)} />}
          </button>
        ) : onActivate ? (
          <button
            type="button"
            title={activateLabel}
            onClick={onActivate}
            className={cn("focus-ring flex min-w-0 items-center rounded-sm text-left", gap, fill)}
          >
            {identity}
          </button>
        ) : (
          <div className={cn("flex min-w-0 items-center", gap, fill)}>{identity}</div>
        )}
        {door ? (
          <OpenSubagentChatButton
            threadId={run.threadId}
            agentName={run.agentName}
            onOpened={onOpened}
          />
        ) : null}
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
