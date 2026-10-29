/**
 * Invocation card block: joins live activity and the saved report source to the
 * launch card. The card's `from` source is durable on its props from the first
 * write, so a reload renders it from the snapshot alone.
 */

import { parseInvocationCard } from "@meridian/contracts/components";
import type { ComponentBlockProps } from "./component-registry";
import { reportPersistedContractFailure } from "./persisted-contract-debug";
import { SpawnReportCard } from "./SpawnReportCard";
import { useSubagentRun } from "./subagent/ActivityContext";

export function HelperResultBlock({ content, invocationResult, threadId }: ComponentBlockProps) {
  const props = parseInvocationCard(content);
  if (!props) {
    reportPersistedContractFailure({ contract: "invocation_card", threadId });
  }
  const run = useSubagentRun({ threadId: props?.childThreadId ?? "" });
  if (!props) return null;
  const liveTool = run?.liveTool ?? null;
  const savedReport =
    props.deliveryMode === "background_notification" &&
    threadId &&
    props.childThreadId &&
    props.execution
      ? { threadId, childThreadId: props.childThreadId, execution: props.execution }
      : null;
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      outcome={props.outcome}
      deliveryMode={props.deliveryMode}
      liveTool={liveTool}
      startedAt={props.startedAt}
      terminalAt={props.terminalAt}
      childThreadId={props.childThreadId ?? null}
      reason={props.reason ?? null}
      directResult={invocationResult}
      savedReport={savedReport}
      run={run}
      from={
        props.fromThreadId
          ? { threadId: props.fromThreadId, title: props.fromThreadTitle ?? null }
          : null
      }
    />
  );
}
