/**
 * Writer-facing subagent launch card. Running, it shows the live tool call;
 * finished, the row expands to the report. Only the chat icon opens the child.
 */

import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { getThreadExecutionReport } from "@/client/api/execution-reports-api";
import { cn } from "@/lib/utils";
import type { DirectInvocationResult } from "./invocation-direct-result";
import { OpenSubagentChatButton } from "./OpenSubagentChatButton";
import { ReportContent } from "./ReportContent";
import { SubagentMark } from "./SubagentMark";
import {
  Elapsed,
  formatSubagentElapsed,
  resolveSubagentName,
  subagentStatus,
} from "./subagent-display";

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
  directResult?: DirectInvocationResult | null;
  savedReport?: SavedReportSource | null;
  liveTool?: string | null;
};

// Detail lines sit under the name: mark (size-6) plus the row gap.
const DETAIL_INDENT = "pl-[calc(1.5rem+var(--chat-space-row))]";

export function SpawnReportCard({
  agentName,
  title,
  status,
  outcome,
  deliveryMode,
  startedAt,
  terminalAt,
  childThreadId,
  directResult = null,
  savedReport = null,
  liveTool,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const resolvedOutcome = directResult?.outcome ?? outcome;
  const displayName = resolveSubagentName({ agentName, title });
  const running = status === "running" && resolvedOutcome == null;
  const markStatus = subagentStatus(
    resolvedOutcome ?? (status === "failed" ? "failed" : undefined),
    running,
  );
  const foreground = deliveryMode === "direct";
  const expandable = !running && (foreground ? directResult != null : savedReport != null);

  const identity = (
    <>
      <SubagentMark agentName={agentName} status={markStatus} />
      <span className="shrink-0 text-sm font-medium text-foreground">{displayName}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {title && title !== displayName ? title : null}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {running ? <Elapsed startedAt={startedAt} /> : formatSubagentElapsed(startedAt, terminalAt)}
      </span>
    </>
  );

  return (
    <div
      className="min-w-0 chat-card [--chat-card-radius:var(--radius-xl)] [--chat-card-border:var(--color-border-subtle)] bg-background shadow-xs"
      data-subagent-card
      data-subagent-thread-id={childThreadId ?? undefined}
      data-delivery-mode={deliveryMode}
    >
      <div className="flex min-w-0 items-center gap-1">
        {expandable ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="focus-ring flex min-w-0 flex-1 items-center gap-[var(--chat-space-row)] rounded-sm text-left"
          >
            {identity}
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-[var(--chat-space-row)]">
            {identity}
          </div>
        )}
        <OpenSubagentChatButton threadId={childThreadId} agentName={agentName} />
      </div>
      {running ? (
        <div
          className={cn(
            "mt-[var(--chat-space-row)] truncate text-xs text-muted-foreground",
            DETAIL_INDENT,
          )}
        >
          {liveTool || <Trans>Working</Trans>}
        </div>
      ) : null}
      {expanded && expandable ? (
        <div className={cn("mt-[var(--chat-space-block)] text-sm", DETAIL_INDENT)}>
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
  const data = saved.data;
  if (!data || !("outcome" in data)) return <Note>{<Trans>Report is unavailable</Trans>}</Note>;
  return (
    <ReportBody
      report={{
        outcome: data.outcome,
        summary: data.summary,
        ...(data.payload === undefined ? {} : { payload: data.payload }),
        artifacts: data.artifacts ?? [],
        partial: data.partial,
        reason: data.reason,
      }}
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
