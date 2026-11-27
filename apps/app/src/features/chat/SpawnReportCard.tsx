import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseThreadReportResult, toReportContentValue } from "@meridian/contracts/spawn";
import type { DirectInvocationResult } from "@meridian/thread-client";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getThreadExecutionReport } from "@/client/api/execution-reports-api";
import { cn } from "@/lib/utils";
import { ExpandableProse } from "./ClippedExpand";
import { SourceChatLink, useSourceThread } from "./derivation/SourceChatLink";
import { ReportContent } from "./ReportContent";
import { useSubagentDisclosure } from "./subagent/DisclosureStore";
import { subagentMarkName } from "./subagent/display";
import type { SubagentRun } from "./subagent/run-model";
import { SubagentRow, SubagentToolLine, subagentBodyIndent } from "./subagent/SubagentRow";
import { SubagentStop, useSubagentStopScope } from "./subagent/SubagentStop";

export type SavedReportSource = { threadId: string; childThreadId: string; execution: string };

export type SpawnSource = { threadId: string; title: string | null };

type Props = {
  agentName: string;
  title: string | null;
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
  from?: SpawnSource | null;
};

export function SpawnReportCard({
  agentName,
  title,
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
  from = null,
}: Props) {
  const [expanded, setExpanded] = useSubagentDisclosure(
    childThreadId ? `run:${childThreadId}` : `execution:${savedReport?.execution ?? "unknown"}`,
  );
  const activityOutcome =
    suppliedRun?.status === "done"
      ? "succeeded"
      : suppliedRun?.status === "failed" || suppliedRun?.status === "cancelled"
        ? suppliedRun.status
        : undefined;
  const resolvedOutcome = directResult?.outcome ?? outcome ?? activityOutcome;
  const running =
    resolvedOutcome == null &&
    (suppliedRun ? suppliedRun.status === "running" : terminalAt === null);
  const statusText = running
    ? null
    : (reason ??
      (resolvedOutcome === "failed"
        ? t`Failed`
        : resolvedOutcome === "cancelled"
          ? t`Stopped`
          : null));
  const run: SubagentRun = suppliedRun ?? {
    threadId: childThreadId,
    ref: null,
    execution: savedReport?.execution ?? null,
    agentName: agentName || "Subagent",
    name: title?.trim() || null,
    status:
      resolvedOutcome === "succeeded"
        ? "done"
        : resolvedOutcome === "failed" || resolvedOutcome === "cancelled"
          ? resolvedOutcome
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
  const stopScope = useSubagentStopScope();

  const card = (stop?: { button: ReactNode; failures: ReactNode }) => (
    <div
      className="min-w-0 chat-card [--chat-card-radius:var(--radius-xl)] [--chat-card-border:var(--color-border-subtle)] bg-background shadow-raise"
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
        trailing={stop?.button}
        detail={
          running ? (
            <div className="space-y-[var(--chat-space-inline)]">
              <SubagentToolLine run={run} fallback={<Trans>Working</Trans>} />
              {stop?.failures}
            </div>
          ) : statusText ? (
            <p className="text-xs text-muted-foreground">{statusText}</p>
          ) : undefined
        }
      />
      {from ? <SpawnSourceLine source={from} /> : null}
      {expanded && expandable ? (
        <div className={cn("mt-[var(--chat-space-block)] text-sm", subagentBodyIndent)}>
          {foreground && directResult ? (
            <ReportBody report={directResult} message={directResult.message} />
          ) : savedReport ? (
            <SavedReportBody source={savedReport} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
  // A background child outlives the reply that started it, so the composer's Stop can't reach it.
  if (running && !foreground && childThreadId && stopScope) {
    return (
      <SubagentStop
        threadId={childThreadId}
        name={run.name ?? subagentMarkName(run.agentName)}
        stopScope={stopScope}
      >
        {card}
      </SubagentStop>
    );
  }
  return card();
}

function ReportBody({
  report,
  message = null,
}: {
  report: import("./ReportContent").ReportContentValue;
  message?: string | null;
}) {
  return (
    <ExpandableProse more={<Trans>Show the whole report</Trans>}>
      <ReportContent
        report={report}
        empty={<Trans>No report text was returned.</Trans>}
        message={message}
        showStopMetadata={false}
        className="space-y-[var(--chat-space-block)]"
      />
    </ExpandableProse>
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

function SpawnSourceLine({ source: { threadId, title } }: { source: SpawnSource }) {
  const source = useSourceThread(threadId, title);
  return (
    <p
      data-spawn-source={threadId}
      className={cn(
        "mt-[var(--chat-space-inline)] flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground",
        subagentBodyIndent,
      )}
    >
      {/* One message, so a translation can put the source's name first. */}
      <Trans>
        <span className="shrink-0">From </span>
        <SourceChatLink threadId={threadId} title={source.title} trashed={source.trashed} />
      </Trans>
    </p>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
