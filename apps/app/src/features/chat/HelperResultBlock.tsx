/** Invocation card block: joins live activity and the saved report source to the launch card. */
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";
import { useSubagentActivity } from "./SubagentActivityContext";
import { subagentCurrentToolLabel } from "./subagent-display";

export function HelperResultBlock({ content, invocationResult, threadId }: ComponentBlockProps) {
  const props = content.props as {
    agentName: string;
    title?: string;
    status: "running" | "completed" | "failed";
    outcome?: "succeeded" | "failed" | "cancelled";
    childThreadId?: string;
    execution?: string | null;
    deliveryMode: "direct" | "background_notification";
    startedAt: string;
    terminalAt: string | null;
  };
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
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      status={props.status}
      outcome={props.outcome}
      deliveryMode={props.deliveryMode}
      liveTool={liveTool}
      startedAt={props.startedAt}
      terminalAt={props.terminalAt}
      childThreadId={props.childThreadId ?? null}
      directResult={invocationResult}
      savedReport={savedReport}
    />
  );
}
