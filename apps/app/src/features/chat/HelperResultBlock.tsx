/** The retained invocation card; background cards read their exact saved report on demand. */
import { useQuery } from "@tanstack/react-query";
import { getThreadExecutionReport } from "@/client/api/execution-reports-api";
import type { ComponentBlockProps } from "./component-registry";
import type { DirectInvocationResult } from "./invocation-direct-result";
import { SpawnReportCard } from "./SpawnReportCard";

export function HelperResultBlock({ content, invocationResult, threadId }: ComponentBlockProps) {
  const props = content.props as {
    agentName: string;
    title?: string;
    status: "running" | "completed" | "failed";
    outcome?: "succeeded" | "failed" | "cancelled";
    childThreadId?: string;
    execution?: string | null;
    deliveryMode?: "direct" | "background_notification";
  };
  const shouldReadSavedReport =
    props.deliveryMode === "background_notification" &&
    props.status !== "running" &&
    Boolean(threadId && props.childThreadId && props.execution);
  const saved = useQuery({
    queryKey: ["thread-execution-report", threadId, props.childThreadId, props.execution],
    queryFn: () =>
      getThreadExecutionReport({
        threadId: threadId as string,
        childThreadId: props.childThreadId as string,
        execution: props.execution as string,
      }),
    enabled: shouldReadSavedReport,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const savedReport: DirectInvocationResult | null =
    saved.data && "outcome" in saved.data
      ? {
          execution: saved.data.execution,
          outcome: saved.data.outcome,
          summary: saved.data.summary,
          ...(saved.data.payload === undefined ? {} : { payload: saved.data.payload }),
          artifacts: saved.data.artifacts ?? [],
          partial: saved.data.partial,
          message: null,
          reason: saved.data.reason,
        }
      : null;
  const unavailable =
    saved.data &&
    "status" in saved.data &&
    (saved.data.status === "unavailable" || saved.data.status === "not_ready")
      ? ({
          execution: props.execution ?? "",
          outcome: null,
          summary: "",
          artifacts: [],
          partial: false,
          message: "Report is unavailable",
          reason: null,
        } satisfies DirectInvocationResult)
      : null;
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      status={props.status}
      outcome={props.outcome}
      childThreadId={props.childThreadId ?? null}
      directResult={invocationResult ?? savedReport ?? unavailable}
      loadingReport={shouldReadSavedReport && saved.isPending}
      reportError={shouldReadSavedReport && saved.isError}
    />
  );
}
