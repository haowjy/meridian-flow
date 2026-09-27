/**
 * Writer-facing subagent launch card. Running, it shows the live tool call;
 * finished, the row expands to the report. Only the chat icon opens the child.
 */

import { Trans } from "@lingui/react/macro";
import { parseThreadReportResult, toReportContentValue } from "@meridian/contracts/spawn";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getThreadExecutionReport } from "@/client/api/execution-reports-api";
import type { DirectInvocationResult } from "./invocation-direct-result";
import { ReportContent } from "./ReportContent";
import { useSubagentDisclosure } from "./subagent/DisclosureStore";
import type { SubagentRun } from "./subagent/run-model";
import { SubagentRow } from "./subagent/SubagentRow";

/** Where a background run's saved report lives; read only once the writer expands the card. */
export type SavedReportSource = { threadId: string; childThreadId: string; execution: string };

type Props = {
  agentName: string;
  title: string | null;
  status: "running" | "completed" | "failed";
  outcome?: "succeeded" | "failed" | "cancelled";
  deliveryMode: "direct" | "background_notification";
  startedAt?: string;
  terminalAt?: string | null;
  childThreadId: string | null;
  reason?: string | null;
  directResult?: DirectInvocationResult | null;
  savedReport?: SavedReportSource | null;
  liveTool?: string | null;
  run?: SubagentRun;
};

export function SpawnReportCard({
  agentName,
  title,
  status,
  outcome,
  deliveryMode,
  startedAt,
  terminalAt,
  childThreadId,
  reason = null,
  directResult = null,
  savedReport = null,
  liveTool,
  run: suppliedRun,
}: Props) {
  const [expanded, setExpanded] = useSubagentDisclosure(
    childThreadId ? `run:${childThreadId}` : `execution:${savedReport?.execution ?? "unknown"}`,
  );
  const resolvedOutcome = directResult?.outcome ?? outcome;
  const running = status === "running" && resolvedOutcome == null;
  const run: SubagentRun = suppliedRun ?? {
    threadId: childThreadId,
    ref: null,
    execution: savedReport?.execution ?? null,
    agentName: agentName || "Subagent",
    description: title?.trim() || null,
    status:
      resolvedOutcome === "succeeded"
        ? "done"
        : resolvedOutcome === "failed" || resolvedOutcome === "cancelled" || status === "failed"
          ? "stopped"
          : running
            ? "running"
            : "unknown",
    startedAt: startedAt ?? null,
    endedAt: terminalAt ?? null,
    liveTool: liveTool ?? null,
    originTurnId: null,
    parentThreadId: savedReport?.threadId ?? null,
    deliveryMode,
  };
  const foreground = deliveryMode === "direct";
  const expandable = !running && (foreground ? directResult != null : savedReport != null);

  return (
    <div
      className="min-w-0 chat-card [--chat-card-radius:var(--radius-xl)] [--chat-card-border:var(--color-border-subtle)] bg-background shadow-xs"
      data-subagent-card
      data-subagent-thread-id={childThreadId ?? undefined}
      data-delivery-mode={deliveryMode}
    >
      <SubagentRow
        run={run}
        size="card"
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        expandable={expandable}
        detail={running ? liveTool || <Trans>Working</Trans> : reason || undefined}
      />
      {expanded && expandable ? (
        <div className="mt-[var(--chat-space-block)] pl-[calc(1.5rem+var(--chat-space-row))] text-sm">
          {foreground && directResult ? (
            <ReportBody report={directResult} message={directResult.message} />
          ) : savedReport ? (
            <SavedReportBody source={savedReport} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReportBody({
  report,
  message = null,
}: {
  report: import("./ReportContent").ReportContentValue;
  message?: string | null;
}) {
  return (
    <ReportContent
      report={report}
      empty={<Trans>No report text was returned.</Trans>}
      message={message}
      showStopMetadata={false}
      className="space-y-[var(--chat-space-block)]"
    />
  );
}

/** Mounted only on expansion, so collapsed cards never fetch. */
function SavedReportBody({ source }: { source: SavedReportSource }) {
  const saved = useQuery({
    queryKey: ["thread-execution-report", source.threadId, source.childThreadId, source.execution],
    queryFn: () => getThreadExecutionReport(source),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (saved.isPending) return <Note>{<Trans>Loading report…</Trans>}</Note>;
  const report = toReportContentValue(parseThreadReportResult(saved.data));
  if (!report) return <Note>{<Trans>Report is unavailable</Trans>}</Note>;
  return <ReportBody report={report} />;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
