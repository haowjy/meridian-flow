/** In-flow summary of direct background runs, with current work on expansion. */

import { Trans } from "@lingui/react/macro";
import { useSubagentRuns } from "./subagent/ActivityContext";
import { useSubagentDisclosure } from "./subagent/DisclosureStore";
import { SubagentMark } from "./subagent/SubagentMark";
import { DisclosureChevron, SubagentRow, SubagentToolLine } from "./subagent/SubagentRow";

export function RunningSubagentsStrip({ threadId }: { threadId: string }) {
  const descendants = useSubagentRuns(threadId, { directOnly: true }).filter(
    (run) => run.deliveryMode === "background_notification" && run.status === "running",
  );
  const [expanded, setExpanded] = useSubagentDisclosure(`panel:${threadId}`);
  if (!descendants.length) return null;
  const single = descendants.length === 1 ? descendants[0] : undefined;
  return (
    <section
      className="relative z-10 border-b border-border-subtle bg-background"
      data-running-subagents
    >
      <div className="mx-auto w-full max-w-chat-column px-6 md:px-8">
        {single ? (
          <SubagentRow
            run={single}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            expandable
            className="py-1 text-caption text-ink-muted"
          >
            <SubagentToolLine run={single} />
          </SubagentRow>
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
                  {descendants.slice(0, 3).map((run) => (
                    <span key={run.threadId} className="rounded-full bg-background p-[2px]">
                      <SubagentMark
                        agentName={run.agentName}
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
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {!expanded ? <Trans>{descendants.length} running</Trans> : null}
              </span>
              <DisclosureChevron expanded={expanded} />
            </button>
            {expanded ? (
              <ul className="pb-1">
                {descendants.map((run) => (
                  <li key={run.threadId} className="text-caption text-ink-muted py-1">
                    <SubagentRow run={run} door />
                    <SubagentToolLine run={run} className="pb-1 pl-7" />
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
