/** In-flow summary of direct background runs, with current work on expansion. */

import { Trans } from "@lingui/react/macro";
import { useSubagentRuns } from "./subagent/ActivityContext";
import { useSubagentDisclosure } from "./subagent/DisclosureStore";
import { SubagentIdentity, SubagentRow, SubagentToolLine } from "./subagent/SubagentRow";

export function RunningSubagentsStrip({ threadId }: { threadId: string }) {
  const children = useSubagentRuns().filter(
    (run) => run.deliveryMode === "background_notification" && run.status === "running",
  );
  const [expanded, setExpanded] = useSubagentDisclosure(`panel:${threadId}`);
  if (!children.length) return null;
  const first = children[0];
  if (!first) return null;
  const aggregate = { ...first, agentName: "Subagent", description: null };
  const single = children.length === 1 ? children[0] : undefined;
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
          <SubagentRow
            run={first}
            identity={
              <>
                <SubagentIdentity
                  run={aggregate}
                  showDescription={false}
                  name={<Trans>{children.length} subagents</Trans>}
                />
                <span className="truncate text-xs text-muted-foreground">
                  <Trans>{children.length} running</Trans>
                </span>
              </>
            }
            door={false}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            expandable
            className="py-1 text-caption text-ink-muted"
          >
            <ul className="pb-1">
              {children.map((run) => (
                <li key={run.threadId} className="py-1 text-caption text-ink-muted">
                  <SubagentRow run={run} />
                  <SubagentToolLine run={run} className="pb-1 pl-7" />
                </li>
              ))}
            </ul>
          </SubagentRow>
        )}
      </div>
    </section>
  );
}
