/** The retained invocation card. It displays direct output only after its durable tool result joins. */
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";

export function HelperResultBlock({ content, invocationResult }: ComponentBlockProps) {
  const props = content.props as {
    agentName: string;
    title?: string;
    status: "running" | "completed" | "failed";
    outcome?: "succeeded" | "failed" | "cancelled";
    childThreadId?: string;
  };
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      status={props.status}
      outcome={props.outcome}
      childThreadId={props.childThreadId ?? null}
      directResult={invocationResult ?? null}
    />
  );
}
