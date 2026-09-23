/**
 * AssistantTurn — single render path for assistant turns.
 *
 * One `Block[]` for live and settled alike: no synthetic `"live-reasoning"`
 * block and no separate `thinkingStream`/`textStream`/`visibleTool` props.
 * `partitionTurn` reduces it to an ordered `RenderItem[]` — process folds
 * (reasoning + process tools) collapse in place, text and artifacts stay
 * visible — so prose never folds and is never remounted by a later reasoning
 * run. Render keys derive from `(turnId, sequence)` via `blockRenderKey`.
 *
 * Draft affordances live OFF the transcript now: pending AI changes are the
 * composer-attached DraftDock's job, and this turn only records what it edited
 * (see `TurnEditsReceipt`). Write vocabulary comes from the mode frozen on the turn.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type Block, isTerminalTurnStatus, type Turn } from "@meridian/contracts/protocol";
import { memo, useMemo } from "react";
import type { ChangeTrailShell } from "@/client/change-trails";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { ImageBlock } from "@/rich-content/ImageBlock";
import { Markdown } from "@/rich-content/Markdown";
import { imageContentForBlock, isImageBlock } from "./block-kind";
import { blockRenderKey } from "./block-render-key";
import { CustomBlockRenderer, type InterruptRespondRequest } from "./CustomBlockRenderer";
import { ErrorBlock } from "./ErrorBlock";
import { groupDeliverySegments } from "./group-delivery-segments";
import { type DirectInvocationResult, directResultsForTurn } from "./invocation-direct-result";
import { ProcessDisclosure } from "./ProcessDisclosure";
import {
  hasVisibleReasoningText,
  partitionTurn,
  type RenderItem,
  type Run,
} from "./partition-turn";
import { StreamingText } from "./StreamingText";
import { ToolRow } from "./ToolRow";
import { TurnBlockStep } from "./TurnBlockStep";
import { hasTurnEditsReceiptContent, TurnEditsReceipt } from "./TurnEditsReceipt";
import { thinkingDigest } from "./thinking-digest";
import { turnWorkReceipts } from "./tool-command";
import { isToolViewVisible } from "./tool-view-visibility";
import type { NavigateToTrailChange } from "./useChangeTrailNavigation";

export type AssistantTurnProps = {
  threadId?: string;
  turn: Turn;
  isLatestAssistant?: boolean;
  onRetry?: () => void;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  changeTrail?: ChangeTrailShell;
  navigateToChange?: NavigateToTrailChange;
};

function AssistantTurnComponent({
  threadId,
  turn,
  isLatestAssistant = false,
  onRetry,
  onRespondToInterrupt,
  changeTrail,
  navigateToChange,
}: AssistantTurnProps) {
  const sortedBlocks = useMemo(
    () => [...turn.blocks].sort((a, b) => a.sequence - b.sequence),
    [turn.blocks],
  );
  const isSettled = isTerminalTurnStatus(turn.status);
  const items = useMemo(() => partitionTurn(sortedBlocks), [sortedBlocks]);
  const directResults = useMemo(() => directResultsForTurn(sortedBlocks), [sortedBlocks]);
  // Progressive-disclosure label: "Thinking part N" for a turn with several
  // process folds (one per artifact/interrupt-delimited stretch).
  // Ordinals count only visible folds: a process item whose runs have nothing
  // to show renders nothing, so it must not advance "Thinking part N" or the
  // total.
  const rows = useMemo(() => {
    const isVisibleFold = (item: RenderItem) =>
      item.kind === "process" && foldHasVisibleContent(item.runs);
    const processCount = items.filter(isVisibleFold).length;
    const result: { item: RenderItem; processOrdinal: number; processCount: number }[] = [];
    let processOrdinal = 0;
    for (const item of items) {
      if (isVisibleFold(item)) processOrdinal += 1;
      result.push({ item, processOrdinal, processCount });
    }
    return result;
  }, [items]);
  const isErrored = turn.status === "error";
  const showsInkDrop = turn.status === "pending" || turn.status === "streaming";
  const isLive = !isSettled;
  const resolvedThreadId = threadId ?? turn.threadId;
  const liveLineage = useTurnLiveLineage(resolvedThreadId, turn.id, { enabled: !isLive });
  const liveLineageDocuments = useMemo(
    () => dedupeTurnEditDocuments(liveLineage.documents ?? []),
    [liveLineage.documents],
  );
  // Work mutations leave no document lineage; their receipts ride the turn's
  // own tool results, so a Work-mutation-only turn still gets its Undo receipt.
  // Gated on settlement like document lineage: a receipt is a record of a
  // finished turn, and mid-stream it would offer Undo on a turn still writing.
  const workReceipts = useMemo(
    () => (isLive ? [] : turnWorkReceipts(sortedBlocks)),
    [isLive, sortedBlocks],
  );

  return (
    <div
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="assistant"
      data-turn-status={turn.status}
    >
      {rows.map(({ item, processOrdinal, processCount }) => (
        <TurnItemView
          key={itemRenderKey(item)}
          item={item}
          processOrdinal={processOrdinal}
          processCount={processCount}
          threadId={resolvedThreadId}
          turnStatus={turn.status}
          onRespondToInterrupt={onRespondToInterrupt}
          writeMode={turn.writeMode ?? "direct"}
          directResult={
            item.kind === "artifact" ? (directResults.get(item.block.id) ?? null) : null
          }
        />
      ))}

      {hasTurnEditsReceiptContent(liveLineageDocuments, changeTrail, workReceipts) ? (
        <TurnEditsReceipt
          threadId={resolvedThreadId}
          turn={turn}
          documents={liveLineageDocuments}
          receipt={liveLineage.receipt}
          workReceipts={workReceipts}
          changeTrail={changeTrail}
          navigateToChange={navigateToChange}
        />
      ) : null}

      {isErrored ? (
        <ErrorBlock
          isLatest={isLatestAssistant}
          kind={turn.blocks.length === 0 ? "send" : "generation"}
          onRetry={isLatestAssistant ? onRetry : undefined}
        />
      ) : null}
      {showsInkDrop ? <InkDrop /> : null}
    </div>
  );
}

function InkDrop() {
  return (
    <div className="mt-[7px] flex min-h-5 items-center" data-live-turn-ink>
      <span className="ink-drop" aria-hidden />
    </div>
  );
}

/**
 * One entry per document, preferring its committed (`live`) lineage.
 *
 * A turn that drafted an edit the writer later applied carries BOTH a `draft`
 * and a `live` entry for the same URI, draft first. The card is a receipt for
 * what happened to the manuscript, so the committed entry is the one that
 * counts — keeping the draft would render an applied edit as if it never landed.
 */
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
  processOrdinal,
  processCount,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  writeMode,
  directResult,
}: {
  item: RenderItem;
  processOrdinal: number;
  processCount: number;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
  directResult: DirectInvocationResult | null;
}) {
  const runs = item.kind === "process" ? item.runs : null;
  const digest = useMemo(
    () => (runs ? thinkingDigest(toolViewsInFold(runs), writeMode) : null),
    [runs, writeMode],
  );

  if (item.kind === "process") {
    if (!foldHasVisibleContent(item.runs)) return null;
    return (
      <div data-turn-item-kind="process">
        <ProcessDisclosure
          label={digest ?? thinkingLabel()}
          ariaLabel={thinkingAriaLabel(processOrdinal - 1, processCount)}
        >
          {item.runs.map((run) => (
            <FoldRun
              key={runRenderKey(run)}
              run={run}
              threadId={threadId}
              turnStatus={turnStatus}
              onRespondToInterrupt={onRespondToInterrupt}
              writeMode={writeMode}
            />
          ))}
        </ProcessDisclosure>
      </div>
    );
  }

  return (
    <div className="space-y-1" data-turn-item-kind={item.kind}>
      <DeliveryBlock
        block={item.block}
        threadId={threadId}
        turnStatus={turnStatus}
        onRespondToInterrupt={onRespondToInterrupt}
        directResult={directResult}
      />
    </div>
  );
});

function thinkingLabel() {
  return <Trans>Thinking</Trans>;
}

function thinkingAriaLabel(processIndex: number, processCount: number): string | undefined {
  return processCount <= 1 ? t`Thinking` : t`Thinking part ${processIndex + 1}`;
}

/**
 * A process item earns its disclosure only when it holds something the writer
 * can read. Reasoning runs always qualify (empty ones are dropped in
 * `partitionTurn`); an activity run qualifies with at least one visible tool
 * row. The gate covers the one gap: a hidden protocol block whose provider
 * omitted its `toolCallId` is not detected as hidden, and `ToolRow` renders
 * nothing for it.
 */
function foldHasVisibleContent(runs: Run[]): boolean {
  return runs.some((run) => run.kind === "reasoning") || toolViewsInFold(runs).length > 0;
}

function toolViewsInFold(runs: Run[]) {
  return runs.flatMap((run) => {
    if (run.kind !== "activity") return [];
    return groupDeliverySegments(run.blocks).flatMap((segment) => {
      if (segment.kind === "tool") return isToolViewVisible(segment.tool) ? [segment.tool] : [];
      if (segment.kind === "tool-run") return segment.tools.filter(isToolViewVisible);
      return [];
    });
  });
}

const FoldRun = memo(function FoldRun({
  run,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  writeMode,
}: {
  run: Run;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
}) {
  if (run.kind === "reasoning") {
    return (
      <>
        {run.blocks.filter(hasVisibleReasoningText).map((block) => (
          <TurnBlockStep key={blockRenderKey(block)} block={block} />
        ))}
      </>
    );
  }

  return (
    <div className="space-y-1" data-activity-block data-fold-activity-run>
      <DeliverySegments
        blocks={run.blocks}
        threadId={threadId}
        turnStatus={turnStatus}
        onRespondToInterrupt={onRespondToInterrupt}
        writeMode={writeMode}
      />
    </div>
  );
});

// A turn with only empty blocks partitions to nothing, so a blockless item
// never reaches render. Returning a stable key instead of throwing keeps a
// stray empty item from tripping the project route error boundary.
function itemRenderKey(item: RenderItem): string {
  if (item.kind !== "process") return `${item.kind}:${blockRenderKey(item.block)}`;
  const firstBlock = item.runs[0]?.blocks[0];
  return firstBlock ? `process:${blockRenderKey(firstBlock)}` : "process:empty";
}

function runRenderKey(run: Run): string {
  const firstBlock = run.blocks[0];
  return firstBlock ? `${run.kind}:${blockRenderKey(firstBlock)}` : run.kind;
}

export const AssistantTurn = memo(AssistantTurnComponent);
AssistantTurn.displayName = "AssistantTurn";

/**
 * Process rows: reasoning, tools, and other process blocks render as icon-rail
 * rows inside the Thinking disclosure. Text and artifacts render outside it
 * (see `DeliveryBlock`); that contrast carries the meaning — the fold is "what
 * the assistant did", prose is "what the assistant said".
 */
const DeliverySegments = memo(function DeliverySegments({
  blocks,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  writeMode,
}: {
  blocks: Block[];
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  writeMode: "direct" | "draft";
}) {
  const segments = useMemo(() => groupDeliverySegments(blocks), [blocks]);
  return (
    <>
      {segments.flatMap((segment) => {
        if (segment.kind === "tool") {
          return [
            <ToolRow
              key={blockRenderKey(segment.tool.keyBlock)}
              tool={segment.tool}
              writeMode={writeMode}
            />,
          ];
        }
        // Claude-style timeline: adjacent tools stack as siblings instead of
        // collapsing into a grouping disclosure. With text-altitude rows the
        // visual weight is low enough that grouping reads as extra chrome.
        if (segment.kind === "tool-run") {
          return segment.tools.map((tool) => (
            <ToolRow key={blockRenderKey(tool.keyBlock)} tool={tool} writeMode={writeMode} />
          ));
        }
        return [
          <DeliveryBlock
            key={blockRenderKey(segment.block)}
            block={segment.block}
            threadId={threadId}
            turnStatus={turnStatus}
            onRespondToInterrupt={onRespondToInterrupt}
          />,
        ];
      })}
    </>
  );
});

// Tool protocol blocks are normalized by `groupDeliverySegments` before this
// branch. Keeping DeliveryBlock tool-free prevents `(tool_*)` placeholders from
// leaking through the generic process renderer.
function DeliveryBlock({
  block,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  directResult,
}: {
  block: Block;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  directResult?: DirectInvocationResult | null;
}) {
  // `activity` blocks are AG-UI progress placeholders (`ACTIVITY_SNAPSHOT` /
  // `ACTIVITY_DELTA` events with no tool target) that the reducer parks under
  // a non-canonical blockType. They're transport-level liveness, not
  // deliverable content. Rendering them produces "(activity)" placeholder rows
  // during streaming; hide them here so the item list stays clean.
  if (block.blockType === ("activity" as Block["blockType"])) return null;

  if (isImageBlock(block)) {
    const content = imageContentForBlock(block);
    if (!content) return null;
    return <ImageBlock content={content} />;
  }
  if (block.blockType === "custom") {
    return (
      <CustomBlockRenderer
        block={block}
        threadId={threadId}
        turnStatus={turnStatus}
        onRespondToInterrupt={onRespondToInterrupt}
        directResult={directResult}
      />
    );
  }
  if (block.blockType === "text") {
    const text = block.textContent ?? "";
    if (!text.trim()) return null;
    // Text is the assistant's voice: full prose, no icon, no rail — and it is
    // only ever rendered here, outside the Thinking fold.
    if (block.status === "partial") {
      return <StreamingText text={text} />;
    }
    return <Markdown>{text}</Markdown>;
  }
  return <TurnBlockStep block={block} />;
}
