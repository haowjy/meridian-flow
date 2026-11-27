import { Trans } from "@lingui/react/macro";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import type { AssistantView, ViewItem, ViewRow, ViewRun } from "@meridian/thread-client";
import { memo, useMemo } from "react";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { Button } from "@/components/ui/button";
import { AgentSavesReceipt } from "@/features/agents/AgentSavesReceipt";
import { AssistantTurnActions } from "./AssistantTurnActions";
import { AskReceipt } from "./ask/AskReceipt";
import { assistantTurnCopyMarkdown } from "./assistant-turn-copy";
import { blockRenderKey } from "./block-render-key";
import { AnchoredCards } from "./ChatCards";
import { CustomBlockRenderer } from "./CustomBlockRenderer";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { ReportContent } from "./ReportContent";
import { StreamingText } from "./StreamingText";
import { DeliveryEventRows } from "./subagent/DeliveryEventRows";
import { ToolRow } from "./ToolRow";
import { TurnBlockStep } from "./TurnBlockStep";
import { hasTurnEditsReceiptContent, TurnEditsReceipt } from "./TurnEditsReceipt";
import { callsThatDidNotRun, TurnStoppedLine } from "./TurnStoppedLine";
import { thinkingDigest } from "./thinking-digest";

export type AssistantTurnProps = {
  threadId?: string;
  turn: Turn;
  view: AssistantView;
  response: NonNullable<ViewRow["response"]>;
  threadUsage?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheReportedInputTokens: number;
    cacheReportedCalls: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheResets: number;
  } | null;
  deliveries?: ViewRow["deliveries"];
  isLatestAssistant?: boolean;
  movedPast?: boolean;
  continuesResponse?: boolean;
  standIn?: boolean;
};

function AssistantTurnComponent({
  threadId,
  turn,
  view,
  response,
  threadUsage,
  deliveries = NO_DELIVERIES,
  isLatestAssistant = false,
  movedPast = false,
  continuesResponse = false,
  standIn = false,
}: AssistantTurnProps) {
  const isSettled = isTerminalTurnStatus(turn.status);
  const { items } = view;
  const copyMarkdown = useMemo(() => assistantTurnCopyMarkdown(view), [view]);
  const showsOnlyCards =
    turn.status === "error" && movedPast && items.length === 0 && deliveries.length === 0;
  const stoppedEmpty = turn.status === "cancelled" && items.length === 0 && deliveries.length === 0;
  const showsInkDrop = turn.status === "pending" || turn.status === "streaming";
  const isLive = !isSettled;
  const resolvedThreadId = threadId ?? turn.threadId;
  const notRun = useMemo(() => (isSettled ? callsThatDidNotRun(items) : []), [isSettled, items]);
  const stopped = turn.status === "cancelled";

  return (
    <div
      data-assistant-turn
      data-latest-assistant={isLatestAssistant ? "true" : undefined}
      data-turn-id={turn.id}
      data-turn-role="assistant"
      data-turn-status={turn.status}
    >
      <div className="flex flex-col gap-[var(--chat-space-block)]">
        {items.map((item) => (
          <TurnItemView key={itemRenderKey(item)} item={item} threadId={resolvedThreadId} />
        ))}
        <AskReceipt threadId={resolvedThreadId} turnId={turn.id} />
        {deliveries.length ? (
          <div data-turn-item-kind="delivery">
            <DeliveryEventRows groups={deliveries} />
          </div>
        ) : null}

        {stopped || notRun.length ? <TurnStoppedLine stopped={stopped} notRun={notRun} /> : null}

        <TurnLineageReceipt
          threadId={resolvedThreadId}
          turn={turn}
          view={view}
          isLive={isLive}
          standIn={standIn}
        />
        {isLive || standIn ? null : <AgentSavesReceipt outcomes={view.agentsSaved} />}

        <AnchoredCards anchor={{ turn: turn.id }} />
      </div>
      {isSettled && !continuesResponse && !standIn && !showsOnlyCards && !stoppedEmpty ? (
        <AssistantTurnActions
          threadId={resolvedThreadId}
          turn={turn}
          response={response}
          markdown={copyMarkdown}
          threadUsage={threadUsage ?? null}
        />
      ) : null}
      {showsInkDrop ? <InkDrop /> : null}
    </div>
  );
}

const NO_DELIVERIES: NonNullable<AssistantTurnProps["deliveries"]> = [];
const NO_WORK_RECEIPTS: AssistantView["workReceipts"] = [];

const TurnLineageReceipt = memo(function TurnLineageReceipt({
  threadId,
  turn,
  view,
  isLive,
  standIn,
}: {
  threadId: string;
  turn: Turn;
  view: AssistantView;
  isLive: boolean;
  standIn: boolean;
}) {
  const liveLineage = useTurnLiveLineage(threadId, turn.id, {
    enabled: !isLive && !standIn,
  });
  const editedDocuments = useMemo(
    () => dedupeTurnEditDocuments(liveLineage.documents ?? []),
    [liveLineage.documents],
  );
  // Work mutations leave no document lineage; their receipts ride the turn's
  // own tool results, so a Work-mutation-only turn still gets its Undo receipt.
  // Gated on settlement like document lineage: a receipt is a record of a
  // finished turn, and mid-stream it would offer Undo on a turn still writing.
  const workReceipts = isLive ? NO_WORK_RECEIPTS : view.workReceipts;
  // A failed read is not an empty turn: the writer's Undo for the documents this reply wrote is
  // somewhere unread. It shows beside any Work receipts, which say nothing about those documents.
  const readFailed = liveLineage.isError && view.wroteDocuments && editedDocuments.length === 0;
  return (
    <>
      {hasTurnEditsReceiptContent(editedDocuments, workReceipts) ? (
        <TurnEditsReceipt
          threadId={threadId}
          turn={turn}
          documents={editedDocuments}
          receipt={liveLineage.receipt}
          receiptReadAt={liveLineage.readAt}
          workReceipts={workReceipts}
        />
      ) : null}
      {readFailed ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <span>
            <Trans>This reply’s edits couldn’t load.</Trans>
          </span>
          <Button variant="outline" size="sm" onClick={liveLineage.refetch}>
            <Trans>Retry loading</Trans>
          </Button>
        </div>
      ) : null}
    </>
  );
});
TurnLineageReceipt.displayName = "TurnLineageReceipt";

function InkDrop() {
  return (
    <div className="mt-[7px] flex min-h-5 items-center" data-live-turn-ink>
      <span className="ink-drop" aria-hidden />
    </div>
  );
}

function dedupeTurnEditDocuments<T extends { uri: string; scope: "live" | "draft" }>(
  documents: readonly T[],
): T[] {
  const byUri = new Map<string, T>();
  for (const document of documents) {
    const existing = byUri.get(document.uri);
    if (existing && (existing.scope === "live" || document.scope !== "live")) continue;
    byUri.set(document.uri, document);
  }
  return [...byUri.values()];
}

const TurnItemView = memo(function TurnItemView({
  item,
  threadId,
}: {
  item: ViewItem;
  threadId: string;
}) {
  const digest = useMemo(
    () => (item.kind === "process" ? thinkingDigest(item.digest) : null),
    [item],
  );
  const toolCallIds = useMemo(
    () =>
      item.kind === "process"
        ? item.runs.flatMap((run) =>
            run.kind === "activity"
              ? run.tools.flatMap((tool) => (tool.toolCallId ? [tool.toolCallId] : []))
              : [],
          )
        : [],
    [item],
  );

  if (item.kind === "process") {
    if (!item.visible) return null;
    return (
      <div data-turn-item-kind="process">
        <ProcessDisclosure label={digest ?? thinkingLabel()} toolCallIds={toolCallIds}>
          {item.runs.map((run) => (
            <FoldRun key={runRenderKey(run)} run={run} />
          ))}
        </ProcessDisclosure>
      </div>
    );
  }

  if (item.kind === "report") {
    return (
      <div
        className="space-y-[var(--chat-space-block)] text-foreground"
        data-turn-item-kind="report"
      >
        <ReportContent
          report={item.report}
          empty={null}
          className="space-y-[var(--chat-space-block)]"
        />
      </div>
    );
  }

  if (item.kind === "text") {
    return (
      <div className="space-y-[var(--chat-space-inline)]" data-turn-item-kind="text">
        <StreamingText
          streamId={blockRenderKey(item.block)}
          text={item.text}
          streaming={item.block.status === "partial"}
        />
      </div>
    );
  }

  return (
    <div className="space-y-[var(--chat-space-inline)]" data-turn-item-kind="artifact">
      <ArtifactItem item={item} threadId={threadId} />
    </div>
  );
});

function thinkingLabel() {
  return <Trans>Thinking</Trans>;
}

const FoldRun = memo(function FoldRun({ run }: { run: ViewRun }) {
  if (run.kind === "reasoning") {
    return (
      <>
        {run.blocks.map((block, index) => (
          <TurnBlockStep
            key={blockRenderKey(block)}
            block={block}
            body={run.texts[index] ?? null}
          />
        ))}
      </>
    );
  }

  return (
    <div className="space-y-[var(--chat-space-inline)]" data-activity-block data-fold-activity-run>
      {run.tools.map((tool) => (
        <ToolRow key={blockRenderKey(tool.keyBlock)} tool={tool} />
      ))}
    </div>
  );
});

// A turn with only empty blocks partitions to nothing, so a blockless item
// never reaches render. Returning a stable key instead of throwing keeps a
// stray empty item from tripping the project route error boundary.
function itemRenderKey(item: ViewItem): string {
  if (item.kind !== "process") return `${item.kind}:${blockRenderKey(item.block)}`;
  const firstBlock = item.runs[0]?.blocks[0];
  return firstBlock ? `process:${blockRenderKey(firstBlock)}` : "process:empty";
}

function runRenderKey(run: ViewRun): string {
  const firstBlock = run.blocks[0];
  return firstBlock ? `${run.kind}:${blockRenderKey(firstBlock)}` : run.kind;
}

export const AssistantTurn = memo(AssistantTurnComponent);
AssistantTurn.displayName = "AssistantTurn";

function ArtifactItem({
  item,
  threadId,
}: {
  item: Extract<ViewItem, { kind: "artifact" }>;
  threadId: string;
}) {
  const { block, direct: directResult } = item;
  if (block.blockType === "custom") {
    return <CustomBlockRenderer block={block} threadId={threadId} directResult={directResult} />;
  }
  return <TurnBlockStep block={block} body={item.text} />;
}
