import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Thread, ThreadSnapshotAncestor } from "@meridian/contracts/protocol";
import { ChevronLeft } from "lucide-react";
import { SubagentMark } from "@/features/chat/SubagentMark";
import { resolveSubagentName } from "@/features/chat/subagent-display";

export function SubagentPathRow({
  subagent,
  ancestors,
  runStatus,
  onOpenParent,
}: {
  subagent: Thread;
  ancestors: ThreadSnapshotAncestor[];
  runStatus: "running" | "done";
  onOpenParent: (threadId: string) => void;
}) {
  const name = resolveSubagentName(subagent);
  return (
    <nav
      aria-label={t`Subagent chat path`}
      className="flex min-h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-border-subtle bg-background px-3 pr-5 text-xs"
    >
      <button
        type="button"
        onClick={() => {
          const parent = ancestors.at(-1);
          if (parent) onOpenParent(parent.id);
        }}
        className="focus-ring inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        <Trans>Back</Trans>
      </button>
      <ol className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        {ancestors.map((ancestor, index) => (
          <li key={ancestor.id} className="flex items-center gap-1">
            {index ? <span className="text-muted-foreground">/</span> : null}
            <button
              type="button"
              onClick={() => onOpenParent(ancestor.id)}
              className="focus-ring max-w-36 truncate rounded px-1 py-1 text-muted-foreground hover:text-foreground"
            >
              {ancestor.agentName?.trim() || ancestor.title?.trim() || <Trans>Writer</Trans>}
            </button>
          </li>
        ))}
        {ancestors.length ? <li className="text-muted-foreground">/</li> : null}
        <li className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
          <SubagentMark name={name} status={runStatus} className="size-5 text-[10px]" />
          {name}
        </li>
      </ol>
    </nav>
  );
}
