/** The retained invocation card: status, child door, and foreground-only direct settlement. */
import { Trans } from "@lingui/react/macro";
import { CheckCircle2, CircleAlert, LoaderCircle, OctagonX } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/rich-content/Markdown";
import { ArtifactCard, type ArtifactCardTone } from "./ArtifactCard";
import { ArtifactGrid } from "./ArtifactGrid";
import { useOpenChatThread } from "./ChatThreadNavigation";
import type { DirectInvocationResult } from "./invocation-direct-result";

type SpawnReportStatus = "running" | "completed" | "failed";
type SpawnReportOutcome = "succeeded" | "failed" | "cancelled";

type SpawnReportCardProps = {
  agentName: string;
  title: string | null;
  status: SpawnReportStatus;
  outcome?: SpawnReportOutcome;
  childThreadId: string | null;
  directResult?: DirectInvocationResult | null;
};

const statusPresentation = {
  running: { Icon: LoaderCircle, tone: "running" },
  completed: { Icon: CheckCircle2, tone: "resolved" },
  failed: { Icon: CircleAlert, tone: "failed" },
  stopped: { Icon: OctagonX, tone: "failed" },
  unavailable: { Icon: CircleAlert, tone: "failed" },
} satisfies Record<string, { Icon: typeof CheckCircle2; tone: ArtifactCardTone }>;

const directOutcomeStatus = {
  succeeded: "completed",
  failed: "failed",
  cancelled: "stopped",
} as const;

export function SpawnReportCard({
  agentName,
  title,
  status,
  outcome,
  childThreadId,
  directResult = null,
}: SpawnReportCardProps) {
  let resolvedStatus: keyof typeof statusPresentation = status;
  if (status === "running") {
    if (directResult?.outcome) resolvedStatus = directOutcomeStatus[directResult.outcome];
    else if (directResult?.outcome === null) resolvedStatus = "unavailable";
  } else if (outcome === "cancelled") {
    resolvedStatus = "stopped";
  }
  const unavailable = resolvedStatus === "unavailable";
  const { Icon, tone } = statusPresentation[resolvedStatus];
  const hint = title && title !== agentName ? title : undefined;

  return (
    <ArtifactCard
      icon={Icon}
      tone={tone}
      title={agentName}
      hint={hint}
      door={childThreadId ? <OpenChildThreadDoor threadId={childThreadId} /> : undefined}
    >
      <div className="text-caption text-muted-foreground">
        {resolvedStatus === "running" ? <Trans>Running</Trans> : null}
        {resolvedStatus === "completed" ? <Trans>Done</Trans> : null}
        {resolvedStatus === "failed" ? <Trans>Failed</Trans> : null}
        {resolvedStatus === "stopped" ? <Trans>Stopped</Trans> : null}
        {resolvedStatus === "unavailable" ? <Trans>Result unavailable</Trans> : null}
      </div>
      {directResult && (directResult.outcome !== null || unavailable) ? (
        <DirectResult result={directResult} />
      ) : null}
    </ArtifactCard>
  );
}

function DirectResult({ result }: { result: DirectInvocationResult }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine =
    (result.summary || payloadText(result.payload)).split(/\r?\n/, 1)[0]?.trim() ?? "";
  const hasReportText = result.summary.length > 0;
  const hasResult = hasReportText || result.payload !== undefined || result.artifacts.length > 0;

  return (
    <div className="mt-2 min-w-0">
      {firstLine ? <Markdown variant="compact">{firstLine}</Markdown> : null}
      {!hasResult ? (
        <div className="text-caption text-muted-foreground">
          {result.message ? <p>{result.message}</p> : null}
          {result.outcome === "succeeded" ? (
            <p>
              <Trans>No report text was returned.</Trans>
            </p>
          ) : null}
          {result.outcome === "failed" || result.outcome === "cancelled" ? (
            <p>
              <Trans>No partial report text was returned.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {hasResult ? (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="text-caption text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground focus-visible:text-foreground"
          >
            {expanded ? <Trans>Hide full result</Trans> : <Trans>Show full result</Trans>}
          </button>
          {expanded ? (
            <div className="mt-2 space-y-2">
              {hasReportText ? <Markdown variant="compact">{result.summary}</Markdown> : null}
              {result.payload !== undefined ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                  {payloadText(result.payload)}
                </pre>
              ) : null}
              {result.artifacts.length > 0 ? <ArtifactGrid artifacts={result.artifacts} /> : null}
              {result.message ? (
                <p className="text-caption text-muted-foreground">{result.message}</p>
              ) : null}
              {result.reason ? (
                <p className="text-caption text-muted-foreground">
                  <Trans>Reason: {result.reason}</Trans>
                </p>
              ) : null}
              {result.partial ? (
                <p className="text-caption text-muted-foreground">
                  <Trans>Partial result</Trans>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function payloadText(payload: DirectInvocationResult["payload"]): string {
  if (payload === undefined) return "";
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

/** The child name is a door; it is not nested in an expansion target. */
function OpenChildThreadDoor({ threadId }: { threadId: string }) {
  const openThread = useOpenChatThread();
  const label = <Trans>Open</Trans>;
  if (!openThread) {
    return <span className="text-caption text-muted-foreground">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => openThread(threadId)}
      className="focus-ring rounded-sm text-caption text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
    >
      {label}
    </button>
  );
}
