/**
 * AssistantTurn — single render path for assistant turns.
 *
 * After Stream S3 convergence: both live and settled turns flow through the
 * SAME `Block[]` model. There is no synthetic `"live-reasoning"` block and no
 * separate `thinkingStream`/`textStream`/`visibleTool` props — in-progress
 * frontiers are partial blocks in the same array. Block render keys derive
 * from `(turnId, sequence)`, so the live→settled swap is an in-place
 * block-content replace, not a remount.
 *
 * Draft affordances live OFF the transcript now: pending AI changes are the
 * composer-attached DraftDock's job, and this turn only records what it edited
 * (see `TurnEditsCard`). `draftWrite` stays a per-turn hint so write tool rows
 * can read "Drafted" instead of "Wrote" when the turn produced a draft.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Block, Turn } from "@meridian/contracts/protocol";
import { memo, useMemo } from "react";
import { useTurnLiveLineage } from "@/client/query/useTurnLiveLineage";
import { ImageBlock } from "@/rich-content/ImageBlock";
import { Markdown } from "@/rich-content/Markdown";
import { imageContentForBlock, isImageBlock } from "./block-kind";
import { blockRenderKey } from "./block-render-key";
import { CustomBlockRenderer, type InterruptRespondRequest } from "./CustomBlockRenderer";
import { ErrorBlock } from "./ErrorBlock";
import { groupDeliverySegments } from "./group-delivery-segments";
import { LiveTurnStatusBar } from "./LiveTurnStatusBar";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { partitionTurnSegments, type Run, type TurnSegment } from "./partition-turn-segments";
import { StreamingText } from "./StreamingText";
import { ToolRow } from "./ToolRow";
import { TurnBlockStep } from "./TurnBlockStep";
import { TurnEditsCard } from "./TurnEditsCard";

export type AssistantTurnProps = {
  threadId?: string;
  turn: Turn;
  isLatestAssistant?: boolean;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  /** True when this turn produced an AI draft (write tool rows read "Drafted"). */
  draftWrite?: boolean;
};

function AssistantTurnComponent({
  threadId,
  turn,
  isLatestAssistant = false,
  onRespondToInterrupt,
  draftWrite = false,
}: AssistantTurnProps) {
  const sortedBlocks = useMemo(
    () => [...turn.blocks].sort((a, b) => a.sequence - b.sequence),
    [turn.blocks],
  );
  const segments = useMemo(() => partitionTurnSegments(sortedBlocks), [sortedBlocks]);
  const isErrored = turn.status === "error";
  const isCancelled = turn.status === "cancelled";
  // A turn is "live" iff its current status is still streaming. Settled turns
  // are anything terminal (`complete`/`cancelled`/`error`).
  const isLive = turn.status === "streaming" || turn.status === "pending";
  const resolvedThreadId = threadId ?? turn.threadId;
  const liveLineage = useTurnLiveLineage(resolvedThreadId, turn.id, { enabled: !isLive });
  const liveLineageDocuments = useMemo(
    () => dedupeTurnEditDocuments(liveLineage.documents ?? []),
    [liveLineage.documents],
  );

  return (
    <div
      className="mb-10"
      data-turn-id={turn.id}
      data-turn-role="assistant"
      data-turn-status={turn.status}
    >
      {segments.map((segment, index) => (
        <TurnSegmentView
          key={segmentRenderKey(segment)}
          segment={segment}
          segmentIndex={index}
          segmentCount={segments.length}
          threadId={resolvedThreadId}
          turnStatus={turn.status}
          onRespondToInterrupt={onRespondToInterrupt}
          draftWrite={draftWrite}
        />
      ))}

      {liveLineageDocuments.length > 0 ? (
        <TurnEditsCard
          threadId={resolvedThreadId}
          turn={turn}
          documents={liveLineageDocuments}
          receipt={liveLineage.receipt}
        />
      ) : null}

      {isLive ? <LiveTurnStatusBar /> : null}
      {isErrored ? <ErrorBlock isLatest={isLatestAssistant} /> : null}
      {isCancelled ? (
        <p className="mt-2 text-caption text-muted-foreground italic">
          <Trans>Turn cancelled.</Trans>
        </p>
      ) : null}
    </div>
  );
}

function dedupeTurnEditDocuments<T extends { uri: string }>(documents: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const document of documents) {
    if (seen.has(document.uri)) continue;
    seen.add(document.uri);
    deduped.push(document);
  }
  return deduped;
}

function TurnSegmentView({
  segment,
  segmentIndex,
  segmentCount,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  draftWrite,
}: {
  segment: TurnSegment;
  segmentIndex: number;
  segmentCount: number;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  draftWrite: boolean;
}) {
  return (
    <div data-turn-segment={segmentIndex + 1}>
      {segment.foldRuns.length > 0 ? (
        <ProcessDisclosure
          label={thinkingLabel()}
          ariaLabel={thinkingAriaLabel(segmentIndex, segmentCount)}
        >
          {segment.foldRuns.map((run) => (
            <FoldRun
              key={runRenderKey(run)}
              run={run}
              threadId={threadId}
              turnStatus={turnStatus}
              onRespondToInterrupt={onRespondToInterrupt}
              draftWrite={draftWrite}
            />
          ))}
        </ProcessDisclosure>
      ) : null}

      {segment.frontier.length > 0 ? (
        <div className="space-y-1" data-activity-block>
          <DeliverySegments
            blocks={segment.frontier}
            threadId={threadId}
            turnStatus={turnStatus}
            mode="frontier"
            onRespondToInterrupt={onRespondToInterrupt}
            draftWrite={draftWrite}
          />
        </div>
      ) : null}
    </div>
  );
}

function thinkingLabel() {
  return <Trans>Thinking</Trans>;
}

function thinkingAriaLabel(segmentIndex: number, segmentCount: number): string | undefined {
  if (segmentCount <= 1) return undefined;
  return t`Thinking part ${segmentIndex + 1}`;
}

function FoldRun({
  run,
  threadId,
  turnStatus,
  onRespondToInterrupt,
  draftWrite,
}: {
  run: Run;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  draftWrite: boolean;
}) {
  if (run.kind === "reasoning") {
    return (
      <>
        {run.blocks.map((block) => (
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
        mode="fold"
        onRespondToInterrupt={onRespondToInterrupt}
        draftWrite={draftWrite}
      />
    </div>
  );
}

function segmentRenderKey(segment: TurnSegment): string {
  const firstBlock = firstSegmentBlock(segment);
  if (!firstBlock) throw new Error("Turn segments must contain at least one block");
  return `segment:${blockRenderKey(firstBlock)}`;
}

function runRenderKey(run: Run): string {
  const firstBlock = run.blocks[0];
  return firstBlock ? `${run.kind}:${blockRenderKey(firstBlock)}` : run.kind;
}

function firstSegmentBlock(segment: TurnSegment): Block | undefined {
  const blocks = [...segment.foldRuns.flatMap((run) => run.blocks), ...segment.frontier];
  return blocks.reduce<Block | undefined>((earliest, block) => {
    if (!earliest || block.sequence < earliest.sequence) return block;
    return earliest;
  }, undefined);
}

export const AssistantTurn = memo(AssistantTurnComponent, areAssistantTurnPropsEqual);
AssistantTurn.displayName = "AssistantTurn";

function areAssistantTurnPropsEqual(prev: AssistantTurnProps, next: AssistantTurnProps): boolean {
  return (
    prev.threadId === next.threadId &&
    prev.turn === next.turn &&
    Boolean(prev.isLatestAssistant) === Boolean(next.isLatestAssistant) &&
    prev.onRespondToInterrupt === next.onRespondToInterrupt &&
    Boolean(prev.draftWrite) === Boolean(next.draftWrite)
  );
}

/**
 * Activity zone is rendered in two visual modes. The routing skeleton is the
 * same; the modes exist so future per-mode tweaks (e.g. tool-row density) have
 * a seam to dispatch through.
 *
 * **Text deliberately breaks the timeline in BOTH modes.** Reasoning, tools,
 * and other process blocks render as icon-rail rows; text renders as full
 * prose with no icon. That contrast carries the meaning: the timeline is
 * "what the assistant did", and text is "what the assistant said". When a
 * text block rolls up into a later `Thinking` fold its altitude does not
 * change — it stays as voice, stepping out of the rail of process around it.
 */
type DeliveryMode = "frontier" | "fold";

function DeliverySegments({
  blocks,
  threadId,
  turnStatus,
  mode,
  onRespondToInterrupt,
  draftWrite,
}: {
  blocks: Block[];
  threadId: string;
  turnStatus: Turn["status"];
  mode: DeliveryMode;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
  draftWrite: boolean;
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
              draftWrite={draftWrite}
            />,
          ];
        }
        // Claude-style timeline: adjacent tools stack as siblings instead of
        // collapsing into a grouping disclosure. With text-altitude rows the
        // visual weight is low enough that grouping reads as extra chrome.
        if (segment.kind === "tool-run") {
          return segment.tools.map((tool) => (
            <ToolRow key={blockRenderKey(tool.keyBlock)} tool={tool} draftWrite={draftWrite} />
          ));
        }
        return [
          <DeliveryBlock
            key={blockRenderKey(segment.block)}
            block={segment.block}
            threadId={threadId}
            turnStatus={turnStatus}
            mode={mode}
            onRespondToInterrupt={onRespondToInterrupt}
          />,
        ];
      })}
    </>
  );
}

// Tool protocol blocks are normalized by `groupDeliverySegments` before this
// branch. Keeping DeliveryBlock tool-free prevents `(tool_*)` placeholders from
// leaking through the generic process renderer.
function DeliveryBlock({
  block,
  threadId,
  turnStatus,
  mode,
  onRespondToInterrupt,
}: {
  block: Block;
  threadId: string;
  turnStatus: Turn["status"];
  mode: DeliveryMode;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
}) {
  // `activity` blocks are AG-UI progress placeholders (`ACTIVITY_SNAPSHOT` /
  // `ACTIVITY_DELTA` events with no tool target) that the reducer parks under
  // a non-canonical blockType. They're plumbing for the LiveTurnStatusBar —
  // not deliverable content. Rendering them produces "(activity)" placeholder
  // rows during streaming; hide them here so the turn frontier stays clean.
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
      />
    );
  }
  if (block.blockType === "text") {
    const text = block.textContent ?? "";
    if (!text.trim()) return null;
    // Text stays as full prose in both modes — it's the assistant's voice and
    // shouldn't read like another process row. The `mode` arg is kept on the
    // signature so future per-mode polish (e.g. fold-text size/tint shift) can
    // dispatch here without re-plumbing the prop chain.
    if (block.status === "partial" && mode === "frontier") {
      return <StreamingText text={text} />;
    }
    return <Markdown>{text}</Markdown>;
  }
  return <TurnBlockStep block={block} />;
}
