import { t } from "@lingui/core/macro";
import type { Thread, ThreadSnapshotAncestor } from "@meridian/contracts/protocol";
import { ChevronLeft } from "lucide-react";
import {
  Elapsed,
  formatSubagentElapsed,
  resolveSubagentName,
  subagentDescription,
  subagentStatus,
} from "@/features/chat/subagent/display";
import { SubagentMark } from "@/features/chat/subagent/SubagentMark";

export function SubagentPathRow({
  subagent,
  ancestors,
  runStatus,
  startedAt,
  endedAt,
  onOpenParent,
}: {
  subagent: Thread;
  ancestors: ThreadSnapshotAncestor[];
  runStatus: "running" | "succeeded" | "failed" | "cancelled" | null;
  startedAt?: string | null;
  endedAt?: string | null;
  onOpenParent: (threadId: string) => void;
}) {
  const name = resolveSubagentName(subagent);
  const description = subagentDescription(subagent);
  return (
    <nav
      aria-label={t`Subagent chat path`}
      className="flex min-h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-border-subtle bg-background px-3 pr-5 text-caption"
    >
      <ol className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        {ancestors.map((ancestor, index) => (
          <li key={ancestor.id} className="flex items-center gap-1">
            {index ? <span className="text-muted-foreground">/</span> : null}
            <button
              type="button"
              onClick={() => onOpenParent(ancestor.id)}
              className="focus-ring inline-flex max-w-44 items-center gap-1 rounded px-1 py-1 text-muted-foreground hover:text-foreground"
            >
              {index === 0 ? <ChevronLeft className="size-3.5 shrink-0" aria-hidden /> : null}
              <span className="truncate">
                {/* The root is the writer's own chat, named by its title, not its agent. */}
                {index === 0
                  ? ancestor.title?.trim() || resolveSubagentName(ancestor)
                  : resolveSubagentName(ancestor)}
              </span>
            </button>
          </li>
        ))}
        {ancestors.length ? <li className="text-muted-foreground">/</li> : null}
        <li className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
          <SubagentMark
            agentName={subagent.agentName}
            status={subagentStatus(runStatus, runStatus === "running")}
            className="size-5 text-[10px]"
          />
          {name}
          {description ? (
            <span className="max-w-60 truncate font-normal text-muted-foreground">
              {description}
            </span>
          ) : null}
          {startedAt ? (
            <span className="font-normal tabular-nums text-muted-foreground">
              {runStatus === "running" ? (
                <Elapsed startedAt={startedAt} />
              ) : (
                formatSubagentElapsed(startedAt, endedAt)
              )}
            </span>
          ) : null}
        </li>
      </ol>
    </nav>
  );
}
