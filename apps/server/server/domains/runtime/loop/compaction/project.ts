/** Projects the latest complete compaction over the effective transcript. */

import type { Block, JsonObject, PromptBake, Turn } from "@meridian/contracts/threads";
import { z } from "zod";
import {
  activeCompaction,
  type CompactionPlanMetadata,
  CompactionPlanMetadataCodec,
  classifyHistoryItem,
  compactionSummaryMetadata,
} from "../../../threads/index.js";
import { orderTurnsByPosition } from "../../../threads/order-turns.js";
import type { PromptBakeRepository } from "../../../threads/ports/repositories.js";
import { bakeHasHistoryTool } from "../history-tool-availability.js";
import type { CompactionPlan } from "./plan.js";
import { type CompactionCut, retainedTail } from "./tail.js";

/** The durable model-visible summary block written by the compaction protocol. */
export const CompactionPropsCodec = z
  .object({
    summary: z.string(),
    excludedTurnCount: z.number().int().nonnegative(),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    model: z.string().min(1),
  })
  .passthrough();
export type CompactionProps = JsonObject & z.infer<typeof CompactionPropsCodec>;

/** Typed read/write envelope for the custom block that carries a compaction summary. */
export const CompactionBlockContentCodec = z
  .object({ kind: z.literal("compaction"), props: CompactionPropsCodec })
  .passthrough();
export type CompactionBlockContent = JsonObject & z.infer<typeof CompactionBlockContentCodec>;

export interface ProjectedActiveHistory {
  turns: Turn[];
  blocks: Block[];
}

function compactionPropsForTurn(turnId: string, blocks: readonly Block[]): CompactionProps {
  const compactionBlock = blocks.find(
    (block) => block.turnId === turnId && block.blockType === "custom",
  );
  if (!compactionBlock) throw new Error(`Complete compaction ${turnId} has no summary block`);
  const envelope = CompactionBlockContentCodec.parse(compactionBlock.content);
  return envelope.props as CompactionProps;
}

function compactionMetadata(turn: Turn): CompactionPlanMetadata {
  return CompactionPlanMetadataCodec.parse(turn.metadata);
}

function summaryTurn(
  compaction: Turn,
  summary: string,
  threadRef: string,
  historyReadable: boolean,
): { turn: Turn; block: Block } {
  const turnId = `${compaction.id}:summary`;
  const textContent = [
    "<system_update>",
    `Conversation summary. Earlier turns of this conversation (${threadRef}) were compacted into the summary below.${historyReadable ? " They remain readable with thread_history." : ""}`,
    "Continue from this summary and the messages after it; do not redo finished work.",
    "",
    summary,
    "</system_update>",
  ].join("\n");
  return {
    turn: {
      id: turnId,
      threadId: compaction.threadId,
      position: -1,
      prevTurnId: null,
      parentTurnId: null,
      role: "user",
      origin: "system",
      writeMode: null,
      status: "complete",
      promptBakeId: null,
      finishReason: null,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: "0",
      responseCount: 0,
      usage: null,
      error: null,
      metadata: compactionSummaryMetadata(),
      createdAt: compaction.createdAt,
      completedAt: compaction.completedAt ?? compaction.createdAt,
      blocks: [],
      responses: [],
      siblingIds: [],
    },
    block: {
      id: `${turnId}:text`,
      turnId,
      responseId: null,
      blockType: "text",
      sequence: 0,
      textContent,
      content: textContent,
      status: "complete",
      createdAt: compaction.createdAt,
    },
  };
}

/** Projects the latest complete compaction using the owning thread's model-visible handle. */
function projectActiveHistory(
  effectiveTurns: readonly Turn[],
  effectiveBlocks: readonly Block[],
  threadRef: string | null,
  compactionBake?: Pick<PromptBake, "id" | "bakedTools"> | null,
): ProjectedActiveHistory {
  if (!effectiveTurns.some((turn) => turn.role === "compaction")) {
    return { turns: [...effectiveTurns], blocks: [...effectiveBlocks] };
  }

  const turns = orderTurnsByPosition(effectiveTurns);
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of effectiveBlocks) {
    const entries = blocksByTurn.get(block.turnId) ?? [];
    entries.push(block);
    blocksByTurn.set(block.turnId, entries);
  }

  // Decode every complete compaction before selecting one; malformed durable state is never absence.
  const completeCompactions = turns
    .filter((turn) => turn.role === "compaction" && turn.status === "complete")
    .map((turn) => ({
      turn,
      metadata: compactionMetadata(turn),
      props: compactionPropsForTurn(turn.id, effectiveBlocks),
    }));
  const activeCompaction = completeCompactions.at(-1);
  if (!activeCompaction) return { turns: [...effectiveTurns], blocks: [...effectiveBlocks] };
  if (!threadRef)
    throw new Error(`Thread ${activeCompaction.turn.threadId} has no ref for compaction summary`);

  const { turn: compaction, metadata, props } = activeCompaction;
  const beforeCompaction = turns.filter((turn) => turn.position < compaction.position);
  const pinnedRequests = metadata.pinnedRequestTurnIds.map((id) => {
    const turn = beforeCompaction.find(
      (turn) => turn.id === id && (turn.role === "user" || turn.role === "system"),
    );
    if (!turn)
      throw new Error(`Complete compaction ${compaction.id} has a missing pinned request ${id}`);
    return turn;
  });
  const cutTurn = turns.find((turn) => turn.id === metadata.compactedThrough.turnId);
  if (!cutTurn || cutTurn.position >= compaction.position) {
    throw new Error(`Complete compaction ${compaction.id} has an invalid cut turn`);
  }

  const cut: CompactionCut = {
    turnId: cutTurn.id,
    ...(metadata.compactedThrough.blockSequence !== undefined
      ? { blockSequence: metadata.compactedThrough.blockSequence }
      : {}),
  };
  const retainable = new Map<string, boolean>();
  for (const turn of beforeCompaction) {
    const kind = classifyHistoryItem(turn).kind;
    retainable.set(turn.id, kind !== "fork_or_handoff_seed" && kind !== "compaction");
  }
  const tail = retainedTail({
    turns: beforeCompaction,
    blocksByTurn,
    cut,
    pinnedRequests,
    canRetain: (turn) => retainable.get(turn.id) ?? true,
  });
  const afterCompaction = turns.filter((turn) => turn.position > compaction.position);
  const historyReadable =
    compactionBake?.id === compaction.promptBakeId && bakeHasHistoryTool(compactionBake);
  const synthetic = summaryTurn(compaction, props.summary, threadRef, historyReadable);
  const projectedTurns = [synthetic.turn, ...tail.map(({ turn }) => turn), ...afterCompaction].map(
    (turn, position) => ({ ...turn, position }),
  );
  const tailByTurn = new Map(tail.map((slice) => [slice.turn.id, slice]));
  const elisions = new Map(metadata.elisions?.map((elision) => [elision.blockId, elision.content]));
  const projectedBlocks = projectedTurns.flatMap((turn) => {
    if (turn.id === synthetic.turn.id) return [synthetic.block];
    const retained = tailByTurn.get(turn.id);
    return retained
      ? retained.blocks.map((block) =>
          elisions.has(block.id)
            ? { ...block, content: elisions.get(block.id) ?? block.content }
            : block,
        )
      : (blocksByTurn.get(turn.id) ?? []);
  });

  return { turns: projectedTurns, blocks: projectedBlocks };
}

/** The cold summary replaces only the cut, never the pin or the verbatim retained tail. */
export function projectCompactedHistory(
  projection: ProjectedActiveHistory,
  plan: Extract<CompactionPlan, { outcome: "planned" }>,
): ProjectedActiveHistory {
  const retained = new Map(
    plan.retainedSuffix.map(({ turn, blocks }) => [
      turn.id,
      new Set(blocks.map((block) => block.sequence)),
    ]),
  );
  const blocks = projection.blocks.filter(
    (block) => !retained.get(block.turnId)?.has(block.sequence),
  );
  const included = new Set(blocks.map((block) => block.turnId));
  return { turns: projection.turns.filter((turn) => included.has(turn.id)), blocks };
}

/** Resolve the summary's own bake, not today's tool registry. */
export async function projectActiveHistoryWithBakes(
  turns: readonly Turn[],
  blocks: readonly Block[],
  threadRef: string | null,
  promptBakes: Pick<PromptBakeRepository, "findById">,
): Promise<ProjectedActiveHistory> {
  const compaction = activeCompaction(turns);
  const bake = compaction?.promptBakeId
    ? await promptBakes.findById(compaction.promptBakeId)
    : null;
  return projectActiveHistory(turns, blocks, threadRef, bake);
}
