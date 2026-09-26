/** Retained invocation card adapter for current run activity and direct results. */
import { t } from "@lingui/core/macro";
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";
import { useSubagentActivity } from "./SubagentActivityContext";

export function HelperResultBlock({ content, invocationResult }: ComponentBlockProps) {
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
  const liveTool =
    live?.currentTool?.toolName === "spawn"
      ? t`Waiting on ${inputAgent(live.currentTool.input)}`
      : (live?.currentTool?.toolName.replaceAll("_", " ") ?? null);
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
      loadingReport={false}
      reportError={false}
    />
  );
}

function inputAgent(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = (input as Record<string, unknown>).agent;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Subagent";
}
