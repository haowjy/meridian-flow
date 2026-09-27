/** Invocation card block: joins live activity and the saved report source to the launch card. */

import { parseInvocationCard } from "@meridian/contracts/components";
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";
import { useSubagentActivity } from "./SubagentActivityContext";
import { subagentCurrentToolLabel } from "./subagent-display";

export function HelperResultBlock({ content, invocationResult, threadId }: ComponentBlockProps) {
  const props = parseInvocationCard(content);
  if (!props) return null;
  const live = useSubagentActivity(props.childThreadId ?? null);
  const liveTool = live?.currentTool
    ? subagentCurrentToolLabel(live.currentTool.toolName, live.currentTool.input)
    : null;
  const savedReport =
    props.deliveryMode === "background_notification" &&
    threadId &&
    props.childThreadId &&
    props.execution
      ? { threadId, childThreadId: props.childThreadId, execution: props.execution }
      : null;
  const status =
    props.terminalAt === null ? "running" : props.outcome === "succeeded" ? "completed" : "failed";
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
    />
  );
}
