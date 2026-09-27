/**
 * Fold row for `thread_report`: the step where the model read a subagent's
 * report. The report itself lives on the launch card; this row records the read.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { JsonValue } from "@meridian/contracts/protocol";
import { parseThreadReportResult, toReportContentValue } from "@meridian/contracts/spawn";
import { requestConversationReveal } from "./conversation-reveal";
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
  const identity = (
    <>
      <span className="font-medium text-foreground">{name}</span>
      {description ? <> {description}</> : null}
    </>
  );
  // The name is a door to the launch card, which holds the same report.
  const who =
    subagent?.originTurnId && subagent.parentThreadId ? (
      <button
        type="button"
        title={t`Jump to in chat`}
        onClick={() =>
          requestConversationReveal({
            kind: "turn",
            threadId: subagent.parentThreadId as string,
            turnId: subagent.originTurnId as string,
            subagentThreadId: subagent.threadId,
            subagentBlock: "card",
          })
        }
        className="focus-ring relative z-10 rounded-sm text-left underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text"
      >
        {identity}
      </button>
    ) : (
      identity
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
  return toReportContentValue(parseThreadReportResult(output));
}

export const THREAD_REPORT_RENDERER: ToolRenderer = {
  title: (tool) => <ThreadReportTitle tool={tool} />,
  expand: threadReportExpand,
};
