/** Plans the pinned request and longest tool-group-aligned retained suffix. */

import type { Block, Turn } from "@meridian/contracts/threads";
import {
  CompactionMetadataCodec,
  classifyHistoryItem,
  isSystemUpdateMetadata,
} from "../../../threads/index.js";
import { orderTurnsByPosition } from "../../../threads/order-turns.js";
import { estimateTurnTokens } from "./estimate.js";
import { type CompactionCut, type RetainedTurnSlice, retainedTail } from "./tail.js";

export type { RetainedTurnSlice } from "./tail.js";

export const DEFAULT_COMPACTION_TAIL_FRACTION = 0.25;

export interface CompactedThrough extends CompactionCut {}

export interface PlanCompactionInput {
  /** Raw effective transcript, not a projected history containing a synthetic summary turn. */
  turns: readonly Turn[];
  blocks: readonly Block[];
  triggerTokens: number;
  summaryReserveTokens: number;
  fixedOverheadTokens: number;
  tailBudgetFraction?: number;
  /** Optional assembled-token estimate; otherwise a conservative JSON bytes/3 estimate is used. */
  estimateTurnTokens?: (turn: Turn, blocks: readonly Block[]) => number;
}

interface CompactionPlanBase {
  /** A null pin is legal only on a no-compaction result and is never persisted. */
  pinnedRequest: Turn | null;
  /** The ordered retained tail after the summary; it contains the pin at its original or lifted place. */
  retainedSuffix: RetainedTurnSlice[];
  minimalTailFits: boolean;
  tailBudgetTokens: number;
  minimalTailTokens: number;
  /** Retained-suffix estimate excludes the separately reserved pinned-request cost. */
  retainedSuffixTokens: number;
}

export type CompactionPlan =
  | (CompactionPlanBase & {
      outcome: "planned";
      pinnedRequest: Turn;
      compactedThrough: CompactedThrough;
    })
  | (CompactionPlanBase & {
      outcome: "no_compaction";
      compactedThrough: null;
    });

interface ToolGroup {
  startSequence: number;
  endSequence: number;
}

interface ClassifiedTurn {
  turn: Turn;
  kind: ReturnType<typeof classifyHistoryItem>["kind"];
  revertsCompactionTurnId: string | null;
  retainable: boolean;
  isPinnedRequest: boolean;
}

interface CutCandidate extends CompactionCut {
  turnIndex: number;
}

interface TurnCost {
  base: number;
  full: number;
  blockCosts: Map<number, number>;
  trailingBlockCosts: Map<number, number>;
  trailingBlockCounts: Map<number, number>;
}

const toolCallIdCodec = (value: unknown): { toolCallId: string } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const toolCallId = (value as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" && toolCallId.length > 0 ? { toolCallId } : null;
};

function toolGroupsIn(turnBlocks: readonly Block[]): ToolGroup[] {
  const pending = new Map<string, number>();
  const groups: ToolGroup[] = [];
  let groupStart: number | null = null;
  for (const block of turnBlocks) {
    if (block.pruned) continue;
    if (block.blockType === "tool_use") {
      const parsed = toolCallIdCodec(block.content);
      if (!parsed) continue;
      if (groupStart === null) groupStart = block.sequence;
      pending.set(parsed.toolCallId, block.sequence);
      continue;
    }
    if (block.blockType !== "tool_result") continue;
    const parsed = toolCallIdCodec(block.content);
    if (!parsed || !pending.has(parsed.toolCallId)) continue;
    pending.delete(parsed.toolCallId);
    if (pending.size === 0 && groupStart !== null) {
      groups.push({ startSequence: groupStart, endSequence: block.sequence });
      groupStart = null;
    }
  }
  return groups;
}

function classifyTurns(turns: readonly Turn[]): ClassifiedTurn[] {
  return turns.map((turn) => {
    const classification = classifyHistoryItem(turn);
    return {
      turn,
      kind: classification.kind,
      revertsCompactionTurnId:
        classification.kind === "undo_marker" ? classification.compactionTurnId : null,
      retainable:
        classification.kind !== "fork_or_handoff_seed" &&
        classification.kind !== "compaction" &&
        classification.kind !== "undo_marker",
      isPinnedRequest: turn.role === "user" && !isSystemUpdateMetadata(turn.metadata),
    };
  });
}

function toolGroupsByTurn(
  turns: readonly ClassifiedTurn[],
  blocksByTurn: ReadonlyMap<string, Block[]>,
): Map<number, ToolGroup[]> {
  const groupsByIndex = new Map<number, ToolGroup[]>();
  turns.forEach(({ turn }, index) => {
    if (turn.role === "assistant")
      groupsByIndex.set(index, toolGroupsIn(blocksByTurn.get(turn.id) ?? []));
  });
  return groupsByIndex;
}

function candidatesFor(
  turns: readonly ClassifiedTurn[],
  groupsByIndex: ReadonlyMap<number, ToolGroup[]>,
  blocksByTurn: ReadonlyMap<string, Block[]>,
): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  turns.forEach(({ turn }, turnIndex) => {
    const turnBlocks = blocksByTurn.get(turn.id) ?? [];
    const lastSequence = turnBlocks.reduce(
      (last, block) => (block.pruned ? last : block.sequence),
      -1,
    );
    for (const group of groupsByIndex.get(turnIndex) ?? []) {
      if (lastSequence > group.endSequence) {
        candidates.push({ turnId: turn.id, turnIndex, blockSequence: group.endSequence });
      }
    }
    candidates.push({ turnId: turn.id, turnIndex });
  });
  return candidates;
}

function activeCompactionCut(turns: readonly ClassifiedTurn[]): CompactionCut | null {
  const revertedIds = new Set(
    turns.flatMap(({ turn, revertsCompactionTurnId }) =>
      turn.status === "complete" && revertsCompactionTurnId ? [revertsCompactionTurnId] : [],
    ),
  );
  const active = [...turns]
    .reverse()
    .find(
      ({ turn, kind }) =>
        kind === "compaction" && turn.status === "complete" && !revertedIds.has(turn.id),
    );
  if (!active) return null;

  const metadata = CompactionMetadataCodec.parse(active.turn.metadata);
  const cutTurn = turns.find(({ turn }) => turn.id === metadata.compactedThrough.turnId)?.turn;
  if (!cutTurn || cutTurn.position >= active.turn.position) {
    throw new Error(`Complete compaction ${active.turn.id} has an invalid cut turn`);
  }
  return {
    turnId: cutTurn.id,
    ...(metadata.compactedThrough.blockSequence !== undefined
      ? { blockSequence: metadata.compactedThrough.blockSequence }
      : {}),
  };
}

function candidatesAfterCut(
  candidates: readonly CutCandidate[],
  turns: readonly ClassifiedTurn[],
  cut: CompactionCut | null,
): CutCandidate[] {
  if (!cut) return [...candidates];
  const cutIndex = turns.findIndex(({ turn }) => turn.id === cut.turnId);
  return candidates.filter((candidate) => {
    if (candidate.turnIndex > cutIndex) return true;
    if (candidate.turnIndex < cutIndex || cut.blockSequence === undefined) return false;
    return candidate.blockSequence === undefined || candidate.blockSequence > cut.blockSequence;
  });
}

function turnCostsFor(
  turns: readonly ClassifiedTurn[],
  blocksByTurn: ReadonlyMap<string, Block[]>,
  estimate: (turn: Turn, blocks: readonly Block[]) => number,
): TurnCost[] {
  return turns.map(({ turn }) => {
    const blocks = (blocksByTurn.get(turn.id) ?? []).filter((block) => !block.pruned);
    const base = Math.max(0, estimate(turn, []));
    const trailingBlockCosts = new Map<number, number>();
    const trailingBlockCounts = new Map<number, number>();
    let full = base;
    const blockCosts = new Map<number, number>();
    for (const block of blocks) {
      const cost = Math.max(0, estimate(turn, [block]) - base);
      blockCosts.set(block.sequence, cost);
      full += cost;
    }
    let trailing = 0;
    let trailingCount = 0;
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      if (!block) continue;
      trailingBlockCosts.set(block.sequence, trailing);
      trailingBlockCounts.set(block.sequence, trailingCount);
      trailing += blockCosts.get(block.sequence) ?? 0;
      trailingCount++;
    }
    return { base, full, blockCosts, trailingBlockCosts, trailingBlockCounts };
  });
}

function suffixCostsExcludingPin(
  turns: readonly ClassifiedTurn[],
  costs: readonly TurnCost[],
  pinnedRequest: Turn | null,
): number[] {
  const suffix = Array.from({ length: turns.length + 1 }, () => 0);
  for (let index = turns.length - 1; index >= 0; index--) {
    const item = turns[index];
    const cost = costs[index];
    suffix[index] =
      (item?.retainable && item.turn.id !== pinnedRequest?.id ? (cost?.full ?? 0) : 0) +
      (suffix[index + 1] ?? 0);
  }
  return suffix;
}

function candidateTailCost(
  candidate: CutCandidate,
  costs: readonly TurnCost[],
  suffixCosts: readonly number[],
): number {
  const followingTurnsCost = suffixCosts[candidate.turnIndex + 1] ?? 0;
  if (candidate.blockSequence === undefined) return followingTurnsCost;
  const cost = costs[candidate.turnIndex];
  if (!cost) return followingTurnsCost;
  const trailingBlocksCost = cost.trailingBlockCosts.get(candidate.blockSequence) ?? 0;
  const turnHeaderCost =
    (cost.trailingBlockCounts.get(candidate.blockSequence) ?? 0) > 0 ? cost.base : 0;
  return turnHeaderCost + trailingBlocksCost + followingTurnsCost;
}

function minimumCutIndex(input: {
  turns: readonly ClassifiedTurn[];
  candidates: readonly CutCandidate[];
  groupsByIndex: ReadonlyMap<number, ToolGroup[]>;
  pinnedRequest: Turn | null;
}): number {
  const { turns, candidates, groupsByIndex, pinnedRequest } = input;
  const pinnedIndex = pinnedRequest
    ? turns.findIndex((entry) => entry.turn.id === pinnedRequest.id)
    : -1;

  let latestRunToolGroup: { turnIndex: number; group: ToolGroup } | null = null;
  if (pinnedIndex >= 0) {
    for (let turnIndex = turns.length - 1; turnIndex > pinnedIndex; turnIndex--) {
      const group = groupsByIndex.get(turnIndex)?.at(-1);
      if (group) {
        latestRunToolGroup = { turnIndex, group };
        break;
      }
    }
  }
  if (latestRunToolGroup) {
    let latestBeforeGroup = -1;
    for (const [index, candidate] of candidates.entries()) {
      const beforeGroup =
        candidate.turnIndex < latestRunToolGroup.turnIndex ||
        (candidate.turnIndex === latestRunToolGroup.turnIndex &&
          candidate.blockSequence !== undefined &&
          candidate.blockSequence < latestRunToolGroup.group.startSequence);
      if (beforeGroup) latestBeforeGroup = index;
      else break;
    }
    if (latestBeforeGroup >= 0) return latestBeforeGroup;
  }

  const latestReplyIndex = turns.reduce(
    (last, item, index) =>
      item.turn.role === "assistant" && item.turn.status === "complete" && index > pinnedIndex
        ? index
        : last,
    -1,
  );
  const latestCutPreservingPinAndReply = candidates.reduce(
    (last, candidate, index) =>
      candidate.turnIndex <= (pinnedIndex >= 0 ? pinnedIndex : latestReplyIndex - 1) &&
      candidate.turnIndex < latestReplyIndex
        ? index
        : last,
    -1,
  );
  if (latestCutPreservingPinAndReply >= 0) return latestCutPreservingPinAndReply;

  if (pinnedIndex >= 0) {
    let cutAtPin = -1;
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.turnIndex <= pinnedIndex) cutAtPin = index;
    }
    if (cutAtPin >= 0) return cutAtPin;
  }
  return Math.max(0, candidates.length - 1);
}

function materializeTail(input: {
  turns: readonly ClassifiedTurn[];
  blocksByTurn: ReadonlyMap<string, Block[]>;
  candidate: CutCandidate;
  pinnedRequest: Turn | null;
}): RetainedTurnSlice[] {
  const { turns, blocksByTurn, candidate, pinnedRequest } = input;
  const canRetain = new Map(turns.map(({ turn, retainable }) => [turn.id, retainable]));
  return retainedTail({
    turns: turns.map(({ turn }) => turn),
    blocksByTurn,
    cut: candidate,
    pinnedRequest,
    canRetain: (turn) => canRetain.get(turn.id) ?? true,
  });
}

function retainedSlicesCost(
  slices: readonly RetainedTurnSlice[],
  costsById: ReadonlyMap<string, TurnCost>,
): number {
  return slices.reduce((total, slice) => {
    const cost = costsById.get(slice.turn.id);
    if (!cost) return total;
    const blockCost = slice.blocks.reduce(
      (sum, block) => sum + (cost.blockCosts.get(block.sequence) ?? 0),
      0,
    );
    return total + cost.base + blockCost;
  }, 0);
}

function noCompactionPlan(input: {
  pinnedRequest: Turn | null;
  minimalTailTokens: number;
  tailBudgetTokens: number;
}): CompactionPlan {
  return {
    outcome: "no_compaction",
    pinnedRequest: input.pinnedRequest,
    retainedSuffix: [],
    compactedThrough: null,
    minimalTailFits: false,
    tailBudgetTokens: input.tailBudgetTokens,
    minimalTailTokens: input.minimalTailTokens,
    retainedSuffixTokens: 0,
  };
}

/** Plans one raw effective transcript's retained tail with fixed prompt/schema cost reserved. */
export function planCompaction(input: PlanCompactionInput): CompactionPlan {
  const turns = orderTurnsByPosition(input.turns);
  const classifiedTurns = classifyTurns(turns);
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of input.blocks) {
    const turnBlocks = blocksByTurn.get(block.turnId) ?? [];
    turnBlocks.push(block);
    blocksByTurn.set(block.turnId, turnBlocks);
  }
  for (const turnBlocks of blocksByTurn.values())
    turnBlocks.sort((a, b) => a.sequence - b.sequence);

  const pinnedRequest =
    [...classifiedTurns].reverse().find((entry) => entry.isPinnedRequest)?.turn ?? null;
  const estimate = input.estimateTurnTokens ?? estimateTurnTokens;
  const costs = turnCostsFor(classifiedTurns, blocksByTurn, estimate);
  const pinnedIndex = pinnedRequest ? turns.findIndex((turn) => turn.id === pinnedRequest.id) : -1;
  const pinnedCost = pinnedIndex >= 0 ? (costs[pinnedIndex]?.full ?? 0) : 0;
  const summaryReserveTokens = Math.max(0, input.summaryReserveTokens);
  const fixedOverheadTokens = Math.max(0, input.fixedOverheadTokens);
  const triggerTokens = Math.max(0, input.triggerTokens);
  const tailBudgetTokens = Math.max(
    0,
    Math.floor(
      Math.min(
        triggerTokens * (input.tailBudgetFraction ?? DEFAULT_COMPACTION_TAIL_FRACTION),
        triggerTokens - summaryReserveTokens - fixedOverheadTokens - pinnedCost,
      ),
    ),
  );

  if (!pinnedRequest) {
    return noCompactionPlan({
      pinnedRequest: null,
      minimalTailTokens: summaryReserveTokens + fixedOverheadTokens,
      tailBudgetTokens,
    });
  }

  const groupsByIndex = toolGroupsByTurn(classifiedTurns, blocksByTurn);
  const candidates = candidatesAfterCut(
    candidatesFor(classifiedTurns, groupsByIndex, blocksByTurn),
    classifiedTurns,
    activeCompactionCut(classifiedTurns),
  );
  if (candidates.length === 0) {
    const minimalTailTokens = summaryReserveTokens + fixedOverheadTokens + pinnedCost;
    return noCompactionPlan({
      pinnedRequest,
      minimalTailTokens,
      tailBudgetTokens,
    });
  }

  const suffixCosts = suffixCostsExcludingPin(classifiedTurns, costs, pinnedRequest);
  const candidateCosts = candidates.map((candidate) =>
    candidateTailCost(candidate, costs, suffixCosts),
  );
  const minimumIndex = minimumCutIndex({
    turns: classifiedTurns,
    candidates,
    groupsByIndex,
    pinnedRequest,
  });
  const minimumCandidate = candidates[minimumIndex] ?? candidates.at(-1);
  if (!minimumCandidate) throw new Error("Compaction candidate list unexpectedly became empty");

  const minimumTail = materializeTail({
    turns: classifiedTurns,
    blocksByTurn,
    candidate: minimumCandidate,
    pinnedRequest,
  });
  const costsById = new Map(turns.map((turn, index) => [turn.id, costs[index]]));
  const minimumRetainedTokens = retainedSlicesCost(minimumTail, costsById);
  const minimalTailTokens = summaryReserveTokens + fixedOverheadTokens + minimumRetainedTokens;

  // Walk from the minimum safe suffix toward older candidates; suffix costs are precomputed once.
  let selectedIndex = minimumIndex;
  while (selectedIndex > 0) {
    const earlierIndex = selectedIndex - 1;
    const earlierCost = candidateCosts[earlierIndex];
    if (
      earlierCost === undefined ||
      earlierCost > tailBudgetTokens ||
      summaryReserveTokens + fixedOverheadTokens + pinnedCost + earlierCost >= triggerTokens
    )
      break;
    selectedIndex = earlierIndex;
  }

  const selectedCut = candidates[selectedIndex] ?? minimumCandidate;
  const cutTurn = turns[selectedCut.turnIndex];
  if (!cutTurn) throw new Error("Compaction cut does not reference a turn");
  const retainedSuffix = materializeTail({
    turns: classifiedTurns,
    blocksByTurn,
    candidate: selectedCut,
    pinnedRequest,
  });
  const retainedSuffixTokens = Math.max(
    0,
    retainedSlicesCost(retainedSuffix, costsById) - pinnedCost,
  );
  const compactedThrough: CompactedThrough = {
    turnId: cutTurn.id,
    ...(selectedCut.blockSequence !== undefined
      ? { blockSequence: selectedCut.blockSequence }
      : {}),
  };

  return {
    outcome: "planned",
    pinnedRequest,
    retainedSuffix,
    compactedThrough,
    minimalTailFits: minimalTailTokens < triggerTokens,
    tailBudgetTokens,
    minimalTailTokens,
    retainedSuffixTokens,
  };
}
