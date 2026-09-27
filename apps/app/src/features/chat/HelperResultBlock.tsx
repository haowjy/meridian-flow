/** Invocation card block: joins live activity and the saved report source to the launch card. */

import { parseInvocationCard } from "@meridian/contracts/components";
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";
import { useSubagentRun } from "./subagent/ActivityContext";

export function HelperResultBlock({ content, invocationResult, threadId }: ComponentBlockProps) {
  const props = parseInvocationCard(content);
  const run = useSubagentRun({ threadId: props?.childThreadId ?? "" });
  if (!props) return null;
  const liveTool = run?.liveTool ?? null;
  const savedReport =
    props.deliveryMode === "background_notification" &&
    threadId &&
    props.childThreadId &&
    props.execution
      ? { threadId, childThreadId: props.childThreadId, execution: props.execution }
      : null;
  const status = run
    ? run.status === "running"
      ? "running"
      : run.status === "done"
        ? "completed"
        : run.status === "stopped"
          ? "failed"
          : "completed"
    : props.terminalAt === null
      ? "running"
      : props.outcome === "succeeded"
        ? "completed"
        : props.outcome
          ? "failed"
          : "completed";
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      status={status}
      outcome={props.outcome}
      deliveryMode={props.deliveryMode}
      liveTool={liveTool}
      startedAt={props.startedAt}
      terminalAt={props.terminalAt}
      childThreadId={props.childThreadId ?? null}
      reason={props.reason ?? null}
      directResult={invocationResult}
      savedReport={savedReport}
      run={run}
    />
  );
}
