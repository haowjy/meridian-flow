import type { ReactNode } from "react";
import { FoldToggle } from "@/components/ui/fold-toggle";
import { cn } from "@/lib/utils";
import { OpenSubagentChatButton } from "../OpenSubagentChatButton";
import { Elapsed, formatSubagentElapsed, resolveSubagentName } from "./display";
import type { SubagentRun } from "./run-model";
import { SubagentMark } from "./SubagentMark";

export const subagentBodyIndent = "pl-[calc(2.5rem+var(--chat-space-inline))]";

export function SubagentIdentity({
  run,
  size = "row",
  agentLabel,
  showName = true,
  afterName,
}: {
  run: SubagentRun;
  size?: "row" | "card";
  agentLabel?: ReactNode;
  showName?: boolean;
  afterName?: ReactNode;
}) {
  return (
    <>
      <SubagentMark
        agentName={run.agentName}
        status={run.status}
        className={size === "card" ? undefined : "size-5 text-xs"}
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

export function SubagentRow({
  run,
  identity: identityOverride,
  size = "row",
  expanded,
  onToggle,
  expandable = false,
  door = true,
  threadIds,
  trailing,
  detail,
  children,
  className,
}: {
  run: SubagentRun;
  identity?: ReactNode;
  size?: "row" | "card";
  expanded?: boolean;
  onToggle?: () => void;
  expandable?: boolean;
  door?: boolean;
  threadIds?: string;
  trailing?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const gap = "gap-[var(--chat-space-inline)]";
  const fill = size === "card" && "flex-1";
  const identity = identityOverride ?? <SubagentIdentity run={run} size={size} />;
  const line = <span className={cn("flex min-w-0 items-center", gap, fill)}>{identity}</span>;
  const lead = <span aria-hidden className="w-3 shrink-0" />;
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center gap-1">
        {expandable ? (
          <FoldToggle
            open={Boolean(expanded)}
            onToggle={() => onToggle?.()}
            data-subagent-thread-ids={threadIds}
            inline
            className={cn(fill)}
          >
            {line}
          </FoldToggle>
        ) : (
          <div className={cn("flex min-w-0 items-center gap-1", fill)}>
            {lead}
            {line}
          </div>
        )}
        {trailing}
        {door ? <OpenSubagentChatButton threadId={run.threadId} agentName={run.agentName} /> : null}
      </div>
      {detail ? (
        <div className={cn("mt-[var(--chat-space-inline)]", subagentBodyIndent)}>{detail}</div>
      ) : null}
      {expanded && children ? (
        <div className={cn("mt-[var(--chat-space-inline)]", subagentBodyIndent)}>{children}</div>
      ) : null}
    </div>
  );
}
