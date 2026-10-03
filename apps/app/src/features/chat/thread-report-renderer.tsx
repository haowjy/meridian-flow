/**
 * Fold row for `thread_report`: the step where the model read a subagent's
 * report. The report itself lives on the launch card; this row records the read.
 * It reads the typed `tool.result`; `tool.output` is the model's text rendering.
 * `SubagentRefLine` names the addressed subagent for every ref-addressed row.
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

/**
 * The subagent a tool call addressed by ref, named the way the other subagent
 * rows name it. The name is a door to the run's launch card when one exists.
 */
export function SubagentRefLine({ handle }: { handle: string }) {
  const subagent = useSubagentRun({ ref: handle });
  const run = subagent ?? fallbackSubagentRun;
  const name = subagent?.name;
  const originTurnId = subagent?.originTurnId;
  const parentThreadId = subagent?.parentThreadId;
  const childThreadId = subagent?.threadId;
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
  return (
    <>
      {who}
      {name ? <span className="ml-1.5 text-muted-foreground">{name}</span> : null}
    </>
  );
}

function ThreadReportTitle({ tool }: { tool: ToolView }) {
  const line = <SubagentRefLine handle={stringInput(toolInputObject(tool), "ref") ?? ""} />;
  if (tool.status === "partial") return <Trans>Reading report from {line}</Trans>;
  if (tool.isError || !readThreadReport(tool.result)) {
    return <Trans>Couldn't read report from {line}</Trans>;
  }
  return <Trans>Read report from {line}</Trans>;
}

function threadReportExpand(tool: ToolView): ToolExpand | null {
  const read = readThreadReport(tool.result);
  if (!read) return null;
  return () => (
    <ReportContent
      report={read.report}
      empty={<Trans>No report text was returned.</Trans>}
      message={
        read.runningAgain ? t`This report is from its previous run. It's running again now.` : null
      }
      showStopMetadata={false}
      className="space-y-[var(--chat-space-block)] text-sm"
    />
  );
}

export type ThreadReportRead = {
  report: ReportContentValue;
  /** The child is running again; this report is from its previous run. */
  runningAgain: boolean;
};

/** The finished report in a typed result, or null for not-ready, refusals and malformed results. */
export function readThreadReport(result: JsonValue | null): ThreadReportRead | null {
  const parsed = parseThreadReportResult(result);
  const report = toReportContentValue(parsed);
  if (!parsed || !report) return null;
  return { report, runningAgain: "running" in parsed && parsed.running === true };
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
