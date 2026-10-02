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
import { useSubagentRun } from "./subagent/ActivityContext";
import type { SubagentRun } from "./subagent/run-model";
import { SubagentIdentityName } from "./subagent/SubagentRow";
import { stringInput, toolInputObject } from "./tool-command";
import type { ToolExpand, ToolRenderer } from "./tool-renderers";

function ThreadReportTitle({ tool }: { tool: ToolView }) {
  const ref = stringInput(toolInputObject(tool), "ref") ?? "";
  const subagent = useSubagentRun({ ref });
  const run = subagent ?? fallbackSubagentRun;
  const name = subagent?.name;
  const originTurnId = subagent?.originTurnId;
  const parentThreadId = subagent?.parentThreadId;
  const childThreadId = subagent?.threadId;
  // The name is a door to the launch card, which holds the same report.
  const who =
    originTurnId && parentThreadId && childThreadId ? (
      <button
        type="button"
        title={t`Jump to in chat`}
        onClick={() =>
          requestConversationReveal({
            kind: "turn",
            threadId: parentThreadId,
            turnId: originTurnId,
            subagentThreadId: childThreadId,
            subagentBlock: "card",
          })
        }
        className="focus-ring relative z-10 rounded-sm text-left underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text"
      >
        <SubagentIdentityName run={run} />
      </button>
    ) : (
      <SubagentIdentityName run={run} />
    );
  const line = (
    <>
      {who}
      {name ? <span className="ml-1.5 text-muted-foreground">{name}</span> : null}
    </>
  );
  if (tool.status === "partial") return <Trans>Reading report from {line}</Trans>;
  if (tool.isError || !threadReportContent(tool.output)) {
    return <Trans>Couldn't read report from {line}</Trans>;
  }
  return <Trans>Read report from {line}</Trans>;
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

const fallbackSubagentRun: SubagentRun = {
  threadId: null,
  ref: null,
  execution: null,
  agentName: "Subagent",
  name: null,
  status: "unknown",
  startedAt: null,
  endedAt: null,
  liveTool: null,
  originTurnId: null,
  parentThreadId: null,
  deliveryMode: null,
};
