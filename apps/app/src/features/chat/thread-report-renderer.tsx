/**
 * Fold row for `thread_report`: the step where the model read a subagent's
 * report. The report itself lives on the launch card; this row records the read.
 */

import { Trans } from "@lingui/react/macro";
import type { JsonValue } from "@meridian/contracts/protocol";
import { isArtifactRef } from "./ArtifactGrid";
import type { ToolView } from "./group-delivery-segments";
import { ReportContent, type ReportContentValue } from "./ReportContent";
import { useSubagentActivityByRef } from "./SubagentActivityContext";
import { resolveSubagentName, subagentDescription } from "./subagent-display";
import { stringInput, toolInputObject } from "./tool-command";
import type { ToolExpand, ToolRenderer } from "./tool-renderers";

function ThreadReportTitle({ tool }: { tool: ToolView }) {
  const ref = stringInput(toolInputObject(tool), "ref") ?? "";
  const subagent = useSubagentActivityByRef(ref);
  const name = resolveSubagentName(subagent);
  const description = subagentDescription(subagent);
  const who = (
    <>
      <span className="font-medium text-foreground">{name}</span>
      {description ? <> {description}</> : null}
    </>
  );
  if (tool.status === "partial") return <Trans>Reading report from {who}</Trans>;
  if (tool.isError || !threadReportContent(tool.output)) {
    return <Trans>Couldn't read report from {who}</Trans>;
  }
  return <Trans>Read report from {who}</Trans>;
}

function threadReportExpand(tool: ToolView): ToolExpand | null {
  const report = threadReportContent(tool.output);
  if (!report) return null;
  return () => (
    <ReportContent
      report={report}
      empty={<Trans>No report text was returned.</Trans>}
      showStopMetadata={false}
      className="space-y-[var(--chat-space-block)] text-sm"
    />
  );
}

/** A saved report, or null for `not_ready` / `unavailable` and malformed output. */
export function threadReportContent(output: JsonValue | null): ReportContentValue | null {
  const record = asRecord(output);
  const value = asRecord(record?.output) ?? record;
  if (!value || typeof value.summary !== "string") return null;
  const outcome = value.outcome;
  return {
    summary: value.summary,
    ...(value.payload === undefined ? {} : { payload: value.payload }),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter(isArtifactRef) : [],
    partial: value.partial === true,
    ...(outcome === "succeeded" || outcome === "failed" || outcome === "cancelled"
      ? { outcome }
      : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function asRecord(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export const THREAD_REPORT_RENDERER: ToolRenderer = {
  title: (tool) => <ThreadReportTitle tool={tool} />,
  expand: threadReportExpand,
};
