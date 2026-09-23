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
} satisfies Record<string, { Icon: typeof CheckCircle2; tone: ArtifactCardTone }>;

export function SpawnReportCard({
  agentName,
  title,
  status,
  outcome,
  childThreadId,
  directResult = null,
}: SpawnReportCardProps) {
  const resolvedStatus = outcome === "cancelled" ? "stopped" : status;
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
      </div>
      {directResult ? <DirectResult result={directResult} /> : null}
    </ArtifactCard>
  );
}

function DirectResult({ result }: { result: DirectInvocationResult }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine =
    (result.summary || payloadText(result.payload)).split(/\r?\n/, 1)[0]?.trim() ?? "";
  const hasReportText = result.summary.length > 0;
  const hasFullDetails = Boolean(
    result.summary ||
      result.payload !== undefined ||
      result.artifacts.length > 0 ||
      result.message ||
      result.partial,
  );
  const hasResult = hasReportText || result.payload !== undefined || result.artifacts.length > 0;

  return (
    <div className="mt-2 min-w-0">
      {firstLine ? <Markdown variant="compact">{firstLine}</Markdown> : null}
      {!hasResult ? (
        <p className="text-caption text-muted-foreground">
          {result.message ? (
            result.message
          ) : result.outcome === "succeeded" ? (
            <Trans>No report text was returned.</Trans>
          ) : (
            <Trans>No partial report text was returned.</Trans>
          )}
        </p>
      ) : null}
      {hasFullDetails ? (
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
