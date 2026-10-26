/** AssistantTurn — single render path for assistant turns. */

import { Trans } from "@lingui/react/macro";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import {
  type AssistantView,
  isImageBlock,
  type ViewItem,
  type ViewRow,
  type ViewRun,
} from "@meridian/thread-client";
import { memo, useMemo } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { ImageBlock, parseImageBlockContent } from "@/rich-content/ImageBlock";
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
import { thinkingDigest } from "./thinking-digest";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export type AssistantTurnProps = {
  threadId?: string;
  turn: Turn;
  /** What the turn shows: its items, decided by the view model. */
  view: AssistantView;
  /** The response this turn belongs to: its parts and usage numbers. */
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
  /**
   * A closing turn follows this one. A failed reply the chat moved past draws only what it said, so a
   * row kept for a card alone (nothing to read) offers no actions.
   */
  movedPast?: boolean;
  /**
   * The next visible turn continues this response (a subagent notification
   * woke the model, with no writer message between), so this part has no
   * settled action row of its own.
   */
  continuesResponse?: boolean;
  /** A Retry's new reply before the server has it: nothing to read or act on yet. */
  standIn?: boolean;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
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
  changeTrail,
  navigateToChange,
}: AssistantTurnProps) {
  const isSettled = isTerminalTurnStatus(turn.status);
  const { items } = view;
  const copyMarkdown = useMemo(() => assistantTurnCopyMarkdown(view), [view]);
  // A failed reply the chat moved past, kept for a card alone: nothing to copy or fork.
  const showsOnlyCards =
    turn.status === "error" && movedPast && items.length === 0 && deliveries.length === 0;
  const showsInkDrop = turn.status === "pending" || turn.status === "streaming";
  const isLive = !isSettled;
  const resolvedThreadId = threadId ?? turn.threadId;

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
        {/* Deliveries under an asking reply arrived after its question, so they follow its receipt. */}
        <AskReceipt threadId={resolvedThreadId} turnId={turn.id} />
        {deliveries.length ? (
          <div data-turn-item-kind="delivery">
            <DeliveryEventRows groups={deliveries} />
          </div>
        ) : null}

        <TurnLineageReceipt
          threadId={resolvedThreadId}
          turn={turn}
          view={view}
          isLive={isLive}
          standIn={standIn}
          changeTrail={changeTrail}
          navigateToChange={navigateToChange}
        />

        <AnchoredCards anchor={{ turn: turn.id }} />
      </div>
      {isSettled && !continuesResponse && !standIn && !showsOnlyCards ? (
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
  changeTrail,
  navigateToChange,
}: {
  threadId: string;
  turn: Turn;
  view: AssistantView;
  isLive: boolean;
  standIn: boolean;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
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
  return hasTurnEditsReceiptContent(editedDocuments, changeTrail, workReceipts) ? (
    <TurnEditsReceipt
      threadId={threadId}
      turn={turn}
      documents={editedDocuments}
      receipt={liveLineage.receipt}
      workReceipts={workReceipts}
      changeTrail={changeTrail}
      navigateToChange={navigateToChange}
    />
  ) : null;
});
TurnLineageReceipt.displayName = "TurnLineageReceipt";

function InkDrop() {
  return (
    <div className="mt-[7px] flex min-h-5 items-center" data-live-turn-ink>
      <span className="ink-drop" aria-hidden />
    </div>
  );
}

/** One entry per document, preferring its committed (`live`) lineage. */
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
        className="space-y-[var(--chat-space-block)] text-prose-foreground"
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
    // Text is the assistant's voice: full prose, no icon, no rail — and it is
    // only ever rendered here, outside the Thinking fold.
    return (
      <div className="space-y-[var(--chat-space-row)]" data-turn-item-kind="text">
        <StreamingText
          streamId={blockRenderKey(item.block)}
          text={item.text}
          streaming={item.block.status === "partial"}
        />
      </div>
    );
  }

  return (
    <div className="space-y-[var(--chat-space-row)]" data-turn-item-kind="artifact">
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

  // Claude-style timeline: adjacent tools stack as siblings instead of
  // collapsing into a grouping disclosure. With text-altitude rows the
  // visual weight is low enough that grouping reads as extra chrome.
  return (
    <div className="space-y-[var(--chat-space-row)]" data-activity-block data-fold-activity-run>
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

// A card, image or unknown block the writer sees outside the Thinking fold.
function ArtifactItem({
  item,
  threadId,
}: {
  item: Extract<ViewItem, { kind: "artifact" }>;
  threadId: string;
}) {
  const { block, direct: directResult } = item;
  if (isImageBlock(block)) {
    const content = parseImageBlockContent(block.content);
    if (!content) return null;
    return <ImageBlock content={content} />;
  }
  if (block.blockType === "custom") {
    return <CustomBlockRenderer block={block} threadId={threadId} directResult={directResult} />;
  }
  return <TurnBlockStep block={block} body={item.text} />;
}
