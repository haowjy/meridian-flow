/** Shared report-body presentation for invocation cards and saved report rows. */
import { Trans } from "@lingui/react/macro";
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { Markdown } from "@/rich-content/Markdown";
import { ArtifactGrid } from "./ArtifactGrid";
import { payloadText } from "./report-payload";

export type ReportContentValue = {
  summary: string;
  payload?: JsonValue;
  artifacts: ArtifactRef[];
  reason?: string | null;
  partial?: boolean;
  outcome?: "succeeded" | "failed" | "cancelled" | null;
};

type ReportContentProps = {
  report: ReportContentValue;
  empty: ReactNode;
  message?: string | null;
  className?: string;
  emptyClassName?: string;
  showStopMetadata?: boolean;
};

export function ReportContent({
  report,
  empty,
  message,
  className,
  emptyClassName,
  showStopMetadata = true,
}: ReportContentProps) {
  const hasContent =
    !!report.summary || report.payload !== undefined || report.artifacts.length > 0;
  if (!hasContent) {
    return (
      <div className={emptyClassName ?? className ?? "text-caption text-muted-foreground"}>
        {message ? <p>{message}</p> : null}
        {empty ? <p>{empty}</p> : null}
        {showStopMetadata && report.reason ? (
          <p>
            <Trans>Reason: {report.reason}</Trans>
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={className}>
      {report.summary ? <Markdown variant="compact">{report.summary}</Markdown> : null}
      {report.payload !== undefined ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {payloadText(report.payload)}
        </pre>
      ) : null}
      {report.artifacts.length ? <ArtifactGrid artifacts={report.artifacts} /> : null}
      {message ? <p className="text-caption text-muted-foreground">{message}</p> : null}
      {showStopMetadata && report.reason ? (
        <p className="text-caption text-muted-foreground">
          <Trans>Reason: {report.reason}</Trans>
        </p>
      ) : null}
      {showStopMetadata && report.partial ? (
        <p className="text-caption text-muted-foreground">
          <Trans>Partial result</Trans>
        </p>
      ) : null}
    </div>
  );
}
