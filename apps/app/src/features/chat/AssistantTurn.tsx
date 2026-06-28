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
 * DraftReviewCard anchoring: when the writer has at least one active AI draft
 * whose `lastActorTurnId` matches THIS turn's id, the producing turn renders
 * the draft-review card(s) directly beneath its segments. The card is the
 * chat-first review surface; it opens the prose preview overlay and owns
 * accept/discard mutations. Groups that don't anchor are surfaced by ChatView
 * in the unanchored fallback strip above the Composer.
 */
import { Trans } from "@lingui/react/macro";
import type { Block, Turn } from "@meridian/contracts/protocol";
import { memo } from "react";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";
import { ImageBlock } from "@/rich-content/ImageBlock";
import { Markdown } from "@/rich-content/Markdown";
import { imageContentForBlock, isImageBlock } from "./block-kind";
import { blockRenderKey } from "./block-render-key";
import { type CheckpointRespondRequest, CustomBlockRenderer } from "./CustomBlockRenderer";
import { DraftReviewCard } from "./DraftReviewCard";
import { ErrorBlock } from "./ErrorBlock";
import { groupDeliverySegments } from "./group-delivery-segments";
import { LiveTurnStatusBar } from "./LiveTurnStatusBar";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { partitionTurnSegments, type Run, type TurnSegment } from "./partition-turn-segments";
import { StreamingText } from "./StreamingText";
import { ToolRow } from "./ToolRow";
import { TurnBlockStep } from "./TurnBlockStep";

export type AssistantTurnProps = {
  threadId?: string;
  turn: Turn;
  isLatestAssistant?: boolean;
  onRespondToCheckpoint?: (request: CheckpointRespondRequest) => void;
  /** Draft groups anchored to this turn (length 0 today when none). */
  draftGroups?: ThreadDraftGroup[];
};

function AssistantTurnComponent({
  threadId,
  turn,
  isLatestAssistant = false,
  onRespondToCheckpoint,
  draftGroups,
}: AssistantTurnProps) {
  const sortedBlocks = [...turn.blocks].sort((a, b) => a.sequence - b.sequence);
  const segments = partitionTurnSegments(sortedBlocks);
  const isErrored = turn.status === "error";
  const isCancelled = turn.status === "cancelled";
  // A turn is "live" iff its current status is still streaming. Settled turns
  // are anything terminal (`complete`/`cancelled`/`error`).
  const isLive = turn.status === "streaming" || turn.status === "pending";
  const resolvedThreadId = threadId ?? turn.threadId;

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
          threadId={resolvedThreadId}
          turnStatus={turn.status}
          onRespondToCheckpoint={onRespondToCheckpoint}
        />
      ))}

      {isLive ? <LiveTurnStatusBar /> : null}
      {isErrored ? <ErrorBlock isLatest={isLatestAssistant} /> : null}
      {isCancelled ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground italic">
          <Trans>Turn cancelled.</Trans>
        </p>
      ) : null}

      {draftGroups && draftGroups.length > 0 ? (
        <div data-draft-anchor>
          {draftGroups.map((group) => (
            <DraftReviewCard key={group.documentId} threadId={resolvedThreadId} group={group} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TurnSegmentView({
  segment,
  segmentIndex,
  threadId,
  turnStatus,
  onRespondToCheckpoint,
}: {
  segment: TurnSegment;
  segmentIndex: number;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToCheckpoint?: (request: CheckpointRespondRequest) => void;
}) {
  return (
    <div data-turn-segment={segmentIndex + 1}>
      {segment.foldRuns.length > 0 ? (
        <ProcessDisclosure label={thinkingLabel(segmentIndex)}>
          {segment.foldRuns.map((run) => (
            <FoldRun
              key={runRenderKey(run)}
              run={run}
              threadId={threadId}
              turnStatus={turnStatus}
              onRespondToCheckpoint={onRespondToCheckpoint}
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
            onRespondToCheckpoint={onRespondToCheckpoint}
          />
        </div>
      ) : null}
    </div>
  );
}

function thinkingLabel(segmentIndex: number) {
  if (segmentIndex === 0) return <Trans>Thinking</Trans>;
  const segmentNumber = segmentIndex + 1;
  return <Trans>Thinking pt{segmentNumber}</Trans>;
}

function FoldRun({
  run,
  threadId,
  turnStatus,
  onRespondToCheckpoint,
}: {
  run: Run;
  threadId: string;
  turnStatus: Turn["status"];
  onRespondToCheckpoint?: (request: CheckpointRespondRequest) => void;
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
        onRespondToCheckpoint={onRespondToCheckpoint}
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
    prev.onRespondToCheckpoint === next.onRespondToCheckpoint &&
    prev.draftGroups === next.draftGroups
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
 * text block rolls up into the `Thinking ptN` fold its altitude does not
 * change — it stays as voice, stepping out of the rail of process around it.
 */
type DeliveryMode = "frontier" | "fold";

function DeliverySegments({
  blocks,
  threadId,
  turnStatus,
  mode,
  onRespondToCheckpoint,
}: {
  blocks: Block[];
  threadId: string;
  turnStatus: Turn["status"];
  mode: DeliveryMode;
  onRespondToCheckpoint?: (request: CheckpointRespondRequest) => void;
}) {
  const segments = groupDeliverySegments(blocks);
  return (
    <>
      {segments.flatMap((segment) => {
        if (segment.kind === "tool") {
          return [<ToolRow key={blockRenderKey(segment.tool.keyBlock)} tool={segment.tool} />];
        }
        // Claude-style timeline: adjacent tools stack as siblings instead of
        // collapsing into a grouping disclosure. With text-altitude rows the
        // visual weight is low enough that grouping reads as extra chrome.
        if (segment.kind === "tool-run") {
          return segment.tools.map((tool) => (
            <ToolRow key={blockRenderKey(tool.keyBlock)} tool={tool} />
          ));
        }
        return [
          <DeliveryBlock
            key={blockRenderKey(segment.block)}
            block={segment.block}
            threadId={threadId}
            turnStatus={turnStatus}
            mode={mode}
            onRespondToCheckpoint={onRespondToCheckpoint}
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
  onRespondToCheckpoint,
}: {
  block: Block;
  threadId: string;
  turnStatus: Turn["status"];
  mode: DeliveryMode;
  onRespondToCheckpoint?: (request: CheckpointRespondRequest) => void;
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
        onRespondToCheckpoint={onRespondToCheckpoint}
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
    return <Markdown variant="answer">{text}</Markdown>;
  }
  return <TurnBlockStep block={block} />;
}
