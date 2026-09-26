/** Writer-facing subagent launch or foreground lifecycle card. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { useOpenChatThread } from "./ChatThreadNavigation";
import type { DirectInvocationResult } from "./invocation-direct-result";
import { ReportContent } from "./ReportContent";
import { payloadText } from "./report-payload";
import { SubagentMark } from "./SubagentMark";

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
  liveTool?: string | null;
  loadingReport?: boolean;
  reportError?: boolean;
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
  directResult = null,
  liveTool,
  loadingReport = false,
  reportError = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const openThread = useOpenChatThread();
  const resolvedOutcome = directResult?.outcome ?? outcome;
  const running = status === "running" && resolvedOutcome == null;
  const stopped = resolvedOutcome === "cancelled";
  const markStatus = running
    ? "running"
    : stopped || resolvedOutcome === "failed"
      ? "stopped"
      : "done";
  const duration = elapsed(
    startedAt,
    running ? new Date().toISOString() : (terminalAt ?? startedAt),
  );
  const firstLine = (
    directResult?.summary || (directResult ? payloadText(directResult.payload) : "")
  )
    .split(/\r?\n/, 1)[0]
    ?.trim();
  const foreground = deliveryMode === "direct";
  const openButton =
    childThreadId && openThread ? (
      <button
        type="button"
        aria-label={t`Open subagent chat`}
        onClick={() => openThread(childThreadId)}
        className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ExternalLink className="size-3.5" aria-hidden />
      </button>
    ) : null;

  return (
    <div
      className="min-w-0 rounded-lg border border-border bg-background px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] shadow-sm"
      data-subagent-card
      data-subagent-thread-id={childThreadId ?? undefined}
      data-delivery-mode={deliveryMode}
    >
      <div className="flex min-w-0 items-center gap-[var(--chat-space-row)]">
        <SubagentMark name={agentName} status={markStatus} />
        <span className="shrink-0 text-sm font-medium text-foreground">{agentName}</span>
        {title && title !== agentName ? (
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{title}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {duration ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{duration}</span>
        ) : null}
        {!running && foreground ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {stopped ? <Trans>Stopped</Trans> : <Trans>Finished</Trans>}
          </span>
        ) : null}
        {openButton}
        {foreground && !running && directResult ? (
          <button
            type="button"
            aria-label={expanded ? t`Hide result` : t`Show result`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="focus-ring grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown
              className={cn("size-4 transition-transform", expanded && "rotate-180")}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      {foreground && running ? (
        <div className="mt-1 pl-8 text-xs text-muted-foreground">
          {liveTool || <Trans>Working</Trans>}
        </div>
      ) : null}
      {foreground && expanded ? (
        <div className="mt-[var(--chat-space-block)] pl-8 text-sm">
          {firstLine ? <Markdown variant="compact">{firstLine}</Markdown> : null}
          {directResult ? (
            <ReportContent
              report={directResult}
              empty={<Trans>No report text was returned.</Trans>}
              message={directResult.message}
              className="mt-[var(--chat-space-block)] space-y-[var(--chat-space-block)]"
            />
          ) : null}
        </div>
      ) : null}
      {foreground && loadingReport ? (
        <div className="mt-1 pl-8 text-xs text-muted-foreground">
          <Trans>Loading report…</Trans>
        </div>
      ) : null}
      {foreground && reportError ? (
        <div className="mt-1 pl-8 text-xs text-muted-foreground">
          <Trans>Report is unavailable</Trans>
        </div>
      ) : null}
    </div>
  );
}

function elapsed(startedAt?: string, endedAt?: string): string {
  if (!startedAt) return "";
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
