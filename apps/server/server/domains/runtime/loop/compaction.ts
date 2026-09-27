/** Pure compaction policy: classify history, resolve limits, plan retained context, and project it. */

import type { Block, JsonObject, Turn } from "@meridian/contracts/threads";
import { z } from "zod";
import { orderTurnsByPosition } from "../../threads/order-turns.js";
import type { GenerateRequest } from "../gateway/index.js";

export const FLOW_ABSOLUTE_CEILING = 400_000;
export const DEFAULT_COMPACTION_TAIL_FRACTION = 0.25;

const compactedThroughCodec = z.object({
  turnId: z.string().min(1),
  blockSequence: z.number().int().nonnegative().optional(),
});

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

/** C4b's persisted plan coordinates and the pinned request that must remain verbatim. */
export const CompactionMetadataCodec = z
  .object({
    compactedThrough: compactedThroughCodec,
    pinnedRequestTurnId: z.string().min(1),
    trigger: z.enum(["auto", "manual"]).optional(),
  })
  .passthrough();
export type CompactionMetadata = z.infer<typeof CompactionMetadataCodec>;

const systemUpdateMetadataCodec = z.object({
  kind: z.literal("system_update"),
  section: z.string().min(1),
});
const metadataSectionCodec = z.object({ section: z.string().min(1) });
const inboxMessageMetadataCodec = z
  .object({
    kind: z.literal("inbox_message").optional(),
    agentRequestKind: z.enum(["child_seed", "foreground_message"]).optional(),
  })
  .passthrough()
  .refine((metadata) => metadata.kind === "inbox_message" || metadata.agentRequestKind != null);
const childCompletionMetadataCodec = z.object({
  kind: z.literal("subagent_update"),
  handle: z.string(),
  outcome: z.string(),
  execution: z.string(),
});
const derivationSeedMetadataCodec = z.object({
  kind: z.literal("derivation_seed"),
  derivation: z.enum(["fork", "handoff"]),
});
const compactionUndoMetadataCodec = z.object({
  kind: z.literal("compaction_undo"),
  revertsCompactionTurnId: z.string().min(1),
});

export type AgentRequestSource = "inbox_message" | "child_seed" | "foreground_message";

export type HistoryItemClass =
  | { kind: "writer_request" }
  | { kind: "agent_request"; source: AgentRequestSource }
  | { kind: "child_completion" }
  | { kind: "work_update" }
  | { kind: "notice" }
  | { kind: "skill_body" }
  | { kind: "image_update" }
  | { kind: "fork_or_handoff_seed"; derivation: "fork" | "handoff" }
  | { kind: "compaction" }
  | { kind: "undo_marker"; compactionTurnId: string }
  | { kind: "system_update" }
  | { kind: "assistant_response" }
  | { kind: "other" };

/** Classifies stored turns once so compaction and history inspection share the same rules. */
export function classifyHistoryItem(
  turn: Pick<Turn, "role" | "origin" | "metadata">,
): HistoryItemClass {
  if (turn.role === "compaction") return { kind: "compaction" };

  const undo = compactionUndoMetadataCodec.safeParse(turn.metadata);
  if (undo.success) {
    return {
      kind: "undo_marker",
      compactionTurnId: undo.data.revertsCompactionTurnId,
    };
  }

  const derivationSeed = derivationSeedMetadataCodec.safeParse(turn.metadata);
  if (derivationSeed.success) {
    return { kind: "fork_or_handoff_seed", derivation: derivationSeed.data.derivation };
  }

  const section = metadataSectionCodec.safeParse(turn.metadata);
  if (section.success && section.data.section === "image_inclusion") {
    // Image-inclusion payload validation lives with C3a; classification needs only its section.
    return { kind: "image_update" };
  }

  const systemUpdate = systemUpdateMetadataCodec.safeParse(turn.metadata);
  if (systemUpdate.success) {
    if (systemUpdate.data.section === "work_context") return { kind: "work_update" };
    if (systemUpdate.data.section === "notices") return { kind: "notice" };
    if (systemUpdate.data.section === "skill_body") return { kind: "skill_body" };
    return { kind: "system_update" };
  }

  const childCompletion = childCompletionMetadataCodec.safeParse(turn.metadata);
  if (turn.role === "system" && childCompletion.success) return { kind: "child_completion" };

  if (turn.role === "user") {
    if (turn.origin === "writer") return { kind: "writer_request" };
    const inbox = inboxMessageMetadataCodec.safeParse(turn.metadata);
    if (turn.origin === "system" && inbox.success) {
      return {
        kind: "agent_request",
        source: inbox.data.agentRequestKind ?? "inbox_message",
      };
    }
    if (turn.origin === "system") return { kind: "agent_request", source: "foreground_message" };
  }

  if (turn.role === "assistant" && turn.origin === "assistant") {
    return { kind: "assistant_response" };
  }
  return { kind: "other" };
}

export interface ResolveCompactionTriggerInput {
  autocompact?: number | null;
  autocompact_pct?: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  responseReserveTokens?: number;
  concurrentRenderSafetyTokens?: number;
}

export type CompactionTriggerSource = "agent_tokens" | "agent_percent" | "off";

export interface CompactionTrigger {
  thresholdTokens: number | null;
  usableWindowTokens: number;
  source: CompactionTriggerSource;
}

/** Resolves the Agent's trigger to a usable token threshold; no config default is active yet. */
export function resolveCompactionTrigger(input: ResolveCompactionTriggerInput): CompactionTrigger {
  const usableWindowTokens = Math.max(
    0,
    Math.floor(
      input.contextWindow -
        input.maxOutputTokens -
        (input.responseReserveTokens ?? 0) -
        (input.concurrentRenderSafetyTokens ?? 0),
    ),
  );
  const agentTokens = input.autocompact;
  const percent = input.autocompact_pct;
  const source: CompactionTriggerSource =
    agentTokens != null ? "agent_tokens" : percent != null ? "agent_percent" : "off";
  if (source === "off") return { thresholdTokens: null, usableWindowTokens, source };

  const configured =
    agentTokens ??
    (percent != null ? Math.floor((Math.max(0, percent) / 100) * usableWindowTokens) : null);
  return {
    thresholdTokens: Math.max(
      0,
      Math.min(configured ?? 0, usableWindowTokens, FLOW_ABSOLUTE_CEILING),
    ),
    usableWindowTokens,
    source,
  };
}

const TOKEN_BYTES_PER_TOKEN = 3;

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}

function tokensForBytes(bytes: number): number {
  return Math.ceil(bytes / TOKEN_BYTES_PER_TOKEN);
}

/** Conservative provider-neutral estimate of one assembled request's input tokens. */
export function estimateRequestTokens(input: {
  request: Pick<GenerateRequest, "messages"> &
    Partial<Pick<GenerateRequest, "tools" | "responseFormat">>;
  baseline: Pick<NonNullable<Turn["usage"]>, "inputTokens"> | null;
}): number {
  const baselineInputTokens =
    input.baseline && "inputTokens" in input.baseline ? input.baseline.inputTokens : null;
  const wholeRequestEstimate = tokensForBytes(
    encodedBytes({
      messages: input.request.messages,
      tools: input.request.tools ?? [],
      responseFormat: input.request.responseFormat ?? null,
    }),
  );
  if (baselineInputTokens === null) return wholeRequestEstimate;
  return Math.max(0, wholeRequestEstimate - Math.max(0, baselineInputTokens));
}

export interface CompactedThrough {
  turnId: string;
  blockSequence?: number;
}

export interface RetainedTurnSlice {
  turn: Turn;
  blocks: Block[];
}

export interface PlanCompactionInput {
  turns: readonly Turn[];
  blocks: readonly Block[];
  triggerTokens: number;
  summaryReserveTokens: number;
  tailBudgetFraction?: number;
  /** Optional assembled-token cost; defaults to a conservative JSON bytes/3 estimate. */
  estimateTurnTokens?: (turn: Turn, blocks: readonly Block[]) => number;
}

export interface CompactionPlan {
  pinnedRequest: Turn | null;
  retainedSuffix: RetainedTurnSlice[];
  keptWorkRefreshSeparators: Turn[];
  compactedThrough: CompactedThrough | null;
  minimalTailFits: boolean;
  tailBudgetTokens: number;
  minimalTailTokens: number;
  retainedSuffixTokens: number;
}

interface ToolGroup {
  startSequence: number;
  endSequence: number;
}

const toolCallIdCodec = z.object({ toolCallId: z.string().min(1) });

function toolGroupsIn(turnBlocks: readonly Block[]): ToolGroup[] {
  const pending = new Map<string, number>();
  const groups: ToolGroup[] = [];
  let groupStart: number | null = null;
  for (const block of [...turnBlocks].sort((a, b) => a.sequence - b.sequence)) {
    if (block.pruned) continue;
    if (block.blockType === "tool_use") {
      const parsed = toolCallIdCodec.safeParse(block.content);
      if (!parsed.success) continue;
      if (groupStart === null) groupStart = block.sequence;
      pending.set(parsed.data.toolCallId, block.sequence);
      continue;
    }
    if (block.blockType !== "tool_result") continue;
    const parsed = toolCallIdCodec.safeParse(block.content);
    if (!parsed.success || !pending.has(parsed.data.toolCallId)) continue;
    pending.delete(parsed.data.toolCallId);
    if (pending.size === 0 && groupStart !== null) {
      groups.push({ startSequence: groupStart, endSequence: block.sequence });
      groupStart = null;
    }
  }
  return groups;
}

function defaultTurnTokens(turn: Turn, blocks: readonly Block[]): number {
  const projectedBlocks = blocks
    .filter((block) => block.turnId === turn.id && !block.pruned)
    .map(({ blockType, sequence, textContent, content }) => ({
      blockType,
      sequence,
      textContent,
      content,
    }));
  return tokensForBytes(
    encodedBytes({ role: turn.role, metadata: turn.metadata, blocks: projectedBlocks }),
  );
}

function canBeRetained(turn: Turn): boolean {
  const kind = classifyHistoryItem(turn).kind;
  return kind !== "fork_or_handoff_seed" && kind !== "compaction" && kind !== "undo_marker";
}

function isSystemUpdate(turn: Turn): boolean {
  return systemUpdateMetadataCodec.safeParse(turn.metadata).success;
}

function latestPinnedRequest(turns: readonly Turn[]): Turn | null {
  return [...turns].reverse().find((turn) => turn.role === "user" && !isSystemUpdate(turn)) ?? null;
}

interface CutCandidate {
  turnIndex: number;
  blockSequence?: number;
}

function candidatesFor(
  turns: readonly Turn[],
  blocksByTurn: ReadonlyMap<string, Block[]>,
): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    if (turn.role === "assistant") {
      const groups = toolGroupsIn(blocksByTurn.get(turn.id) ?? []);
      for (const group of groups) {
        const hasFollowingBlock = (blocksByTurn.get(turn.id) ?? []).some(
          (block) => !block.pruned && block.sequence > group.endSequence,
        );
        if (hasFollowingBlock) candidates.push({ turnIndex, blockSequence: group.endSequence });
      }
    }
    candidates.push({ turnIndex });
  }
  return candidates;
}

function afterCut(input: {
  turns: readonly Turn[];
  blocksByTurn: ReadonlyMap<string, Block[]>;
  cut: CutCandidate;
  pinnedRequestId: string | null;
}): RetainedTurnSlice[] {
  const { turns, blocksByTurn, cut, pinnedRequestId } = input;
  const retained: RetainedTurnSlice[] = [];
  for (let index = cut.turnIndex; index < turns.length; index++) {
    const turn = turns[index];
    if (!turn || !canBeRetained(turn) || turn.id === pinnedRequestId) continue;
    const turnBlocks = (blocksByTurn.get(turn.id) ?? []).filter((block) => !block.pruned);
    const cutBlockSequence = cut.blockSequence;
    const selectedBlocks =
      index === cut.turnIndex && cutBlockSequence !== undefined
        ? turnBlocks.filter((block) => block.sequence > cutBlockSequence)
        : index === cut.turnIndex && cutBlockSequence === undefined
          ? []
          : turnBlocks;
    if (index === cut.turnIndex && cut.blockSequence === undefined) continue;
    if (turn.role !== "assistant" || selectedBlocks.length > 0) {
      retained.push({ turn, blocks: selectedBlocks });
    }
  }
  return retained;
}

function retainedTokenCount(
  retained: readonly RetainedTurnSlice[],
  estimate: (turn: Turn, blocks: readonly Block[]) => number,
): number {
  return retained.reduce((sum, slice) => sum + Math.max(0, estimate(slice.turn, slice.blocks)), 0);
}

function latestCompleteToolGroup(
  turns: readonly Turn[],
  blocksByTurn: ReadonlyMap<string, Block[]>,
): { turnIndex: number; group: ToolGroup } | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = turns[turnIndex];
    if (turn?.role !== "assistant") continue;
    const group = toolGroupsIn(blocksByTurn.get(turn.id) ?? []).at(-1);
    if (group) return { turnIndex, group };
  }
  return null;
}

function minimumCutIndex(input: {
  turns: readonly Turn[];
  candidates: readonly CutCandidate[];
  blocksByTurn: ReadonlyMap<string, Block[]>;
  pinnedRequest: Turn | null;
}): number {
  const { turns, candidates, blocksByTurn, pinnedRequest } = input;
  const latestGroup = latestCompleteToolGroup(turns, blocksByTurn);
  if (latestGroup) {
    let candidateIndex = 0;
    for (const [index, candidate] of candidates.entries()) {
      const isBeforeGroup =
        candidate.turnIndex < latestGroup.turnIndex ||
        (candidate.turnIndex === latestGroup.turnIndex &&
          candidate.blockSequence !== undefined &&
          candidate.blockSequence < latestGroup.group.startSequence);
      if (!isBeforeGroup) break;
      candidateIndex = index;
    }
    return candidateIndex;
  }

  let latestReplyIndex = -1;
  turns.forEach((turn, index) => {
    if (turn.role === "assistant" && turn.status === "complete") latestReplyIndex = index;
  });
  if (latestReplyIndex >= 0) {
    let beforeReply = -1;
    for (const [index, candidate] of candidates.entries()) {
      const suffixStart =
        candidate.blockSequence === undefined ? candidate.turnIndex + 1 : candidate.turnIndex;
      if (suffixStart > latestReplyIndex) break;
      beforeReply = index;
    }
    if (beforeReply >= 0) return beforeReply;
  }

  if (pinnedRequest) {
    const afterRequest = candidates.findIndex(
      (candidate) => candidate.turnIndex >= turns.indexOf(pinnedRequest),
    );
    if (afterRequest >= 0) return afterRequest;
  }
  return Math.max(0, candidates.length - 1);
}

/** Plans a Q1 suffix: the latest request is pinned, while the longest legal tail fits its budget. */
export function planCompaction(input: PlanCompactionInput): CompactionPlan {
  const turns = orderTurnsByPosition(input.turns);
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of input.blocks) {
    const turnBlocks = blocksByTurn.get(block.turnId) ?? [];
    turnBlocks.push(block);
    blocksByTurn.set(block.turnId, turnBlocks);
  }
  for (const turnBlocks of blocksByTurn.values())
    turnBlocks.sort((a, b) => a.sequence - b.sequence);

  const pinnedRequest = latestPinnedRequest(turns);
  const estimate =
    input.estimateTurnTokens ??
    ((turn: Turn, blocks: readonly Block[]) => defaultTurnTokens(turn, blocks));
  const tailBudgetTokens = Math.max(
    0,
    Math.floor(
      input.triggerTokens * (input.tailBudgetFraction ?? DEFAULT_COMPACTION_TAIL_FRACTION),
    ),
  );
  const candidates = candidatesFor(turns, blocksByTurn);
  const pinnedBlocks = pinnedRequest
    ? (blocksByTurn.get(pinnedRequest.id) ?? []).filter((block) => !block.pruned)
    : [];
  if (candidates.length === 0) {
    const pinnedTokens = pinnedRequest ? estimate(pinnedRequest, pinnedBlocks) : 0;
    const minimalTailTokens = Math.max(0, input.summaryReserveTokens) + Math.max(0, pinnedTokens);
    return {
      pinnedRequest,
      retainedSuffix: [],
      keptWorkRefreshSeparators: [],
      compactedThrough: null,
      minimalTailFits: minimalTailTokens < input.triggerTokens,
      tailBudgetTokens,
      minimalTailTokens,
      retainedSuffixTokens: 0,
    };
  }

  const minimumIndex = minimumCutIndex({ turns, candidates, blocksByTurn, pinnedRequest });
  const minimumCut = candidates[minimumIndex] ?? candidates.at(-1);
  if (!minimumCut) throw new Error("Compaction candidate list unexpectedly became empty");
  const minimumSuffix = afterCut({
    turns,
    blocksByTurn,
    cut: minimumCut,
    pinnedRequestId: pinnedRequest?.id ?? null,
  });
  const pinnedTokens = pinnedRequest ? Math.max(0, estimate(pinnedRequest, pinnedBlocks)) : 0;
  const minimalTailTokens =
    Math.max(0, input.summaryReserveTokens) +
    pinnedTokens +
    retainedTokenCount(minimumSuffix, estimate);

  let selectedIndex = minimumIndex;
  for (let index = 0; index <= minimumIndex; index++) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const suffix = afterCut({
      turns,
      blocksByTurn,
      cut: candidate,
      pinnedRequestId: pinnedRequest?.id ?? null,
    });
    if (retainedTokenCount(suffix, estimate) <= tailBudgetTokens) {
      selectedIndex = index;
      break;
    }
  }

  const selectedCut = candidates[selectedIndex] ?? minimumCut;
  const compactedThroughTurn = turns[selectedCut.turnIndex];
  if (!compactedThroughTurn) throw new Error("Compaction cut does not reference a turn");
  const retainedSuffix = afterCut({
    turns,
    blocksByTurn,
    cut: selectedCut,
    pinnedRequestId: pinnedRequest?.id ?? null,
  });
  const retainedSuffixTokens = retainedTokenCount(retainedSuffix, estimate);
  const compactedThrough: CompactedThrough = {
    turnId: compactedThroughTurn.id,
    ...(selectedCut.blockSequence !== undefined
      ? { blockSequence: selectedCut.blockSequence }
      : {}),
  };
  return {
    pinnedRequest,
    retainedSuffix,
    keptWorkRefreshSeparators: retainedSuffix
      .filter((slice) => classifyHistoryItem(slice.turn).kind === "work_update")
      .map((slice) => slice.turn),
    compactedThrough,
    minimalTailFits: minimalTailTokens < input.triggerTokens,
    tailBudgetTokens,
    minimalTailTokens,
    retainedSuffixTokens,
  };
}

export interface ProjectedActiveHistory {
  turns: Turn[];
  blocks: Block[];
}

function compactionPropsForTurn(turnId: string, blocks: readonly Block[]): CompactionProps | null {
  for (const block of blocks) {
    if (block.turnId !== turnId || block.blockType !== "custom" || block.pruned) continue;
    const envelope = CompactionBlockContentCodec.safeParse(block.content);
    if (envelope.success) return envelope.data.props as CompactionProps;
  }
  return null;
}

function compactionMetadata(turn: Turn): CompactionMetadata | null {
  const parsed = CompactionMetadataCodec.safeParse(turn.metadata);
  return parsed.success ? parsed.data : null;
}

function revertedCompactionIds(turns: readonly Turn[]): Set<string> {
  const reverted = new Set<string>();
  for (const turn of turns) {
    if (turn.status !== "complete") continue;
    const classification = classifyHistoryItem(turn);
    if (classification.kind === "undo_marker") reverted.add(classification.compactionTurnId);
  }
  return reverted;
}

function summaryTurn(
  compaction: Turn,
  summary: string,
  ordinal: number,
): { turn: Turn; block: Block } {
  const turnId = `${compaction.id}:summary`;
  const textContent = [
    "<system_update>",
    `Conversation summary. Earlier turns of this conversation (c${ordinal}) were compacted into the summary below. Read them with thread_history if you need detail.`,
    "",
    summary,
    "</system_update>",
  ].join("\n");
  return {
    turn: {
      ...compaction,
      id: turnId,
      position: -1,
      role: "user",
      origin: "system",
      metadata: { kind: "system_update", section: "compaction_summary" },
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

/** Projects a complete active compaction over an effective transcript, including inherited fork rows. */
export function projectActiveHistory(
  effectiveTurns: readonly Turn[],
  effectiveBlocks: readonly Block[],
): ProjectedActiveHistory {
  const turns = orderTurnsByPosition(effectiveTurns);
  const reverted = revertedCompactionIds(turns);
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of effectiveBlocks) {
    const entries = blocksByTurn.get(block.turnId) ?? [];
    entries.push(block);
    blocksByTurn.set(block.turnId, entries);
  }
  const candidates = turns.filter((turn) => {
    return (
      turn.role === "compaction" &&
      turn.status === "complete" &&
      !reverted.has(turn.id) &&
      compactionMetadata(turn) !== null &&
      compactionPropsForTurn(turn.id, effectiveBlocks) !== null
    );
  });
  const compaction = candidates.at(-1);
  if (!compaction) return { turns: [...effectiveTurns], blocks: [...effectiveBlocks] };

  const metadata = compactionMetadata(compaction);
  const props = compactionPropsForTurn(compaction.id, effectiveBlocks);
  if (!metadata || !props) return { turns: [...effectiveTurns], blocks: [...effectiveBlocks] };
  const beforeCompaction = turns.filter((turn) => turn.position < compaction.position);
  const pinned =
    beforeCompaction.find((turn) => turn.id === metadata.pinnedRequestTurnId) ??
    latestPinnedRequest(beforeCompaction);
  const cutTurn = turns.find((turn) => turn.id === metadata.compactedThrough.turnId);
  if (!cutTurn || cutTurn.position >= compaction.position) {
    return { turns: [...effectiveTurns], blocks: [...effectiveBlocks] };
  }

  const prefixTurns = turns.filter((turn) => turn.position < compaction.position);
  const suffix: RetainedTurnSlice[] = [];
  const cutIndex = prefixTurns.findIndex((turn) => turn.id === cutTurn.id);
  for (let index = 0; index < prefixTurns.length; index++) {
    const turn = prefixTurns[index];
    if (!turn || turn.id === pinned?.id || !canBeRetained(turn)) continue;
    if (index < cutIndex) continue;
    const allBlocks = (blocksByTurn.get(turn.id) ?? []).filter((block) => !block.pruned);
    const blockSequence = metadata.compactedThrough.blockSequence;
    const retainedBlocks =
      turn.id === cutTurn.id && blockSequence !== undefined
        ? allBlocks.filter((block) => block.sequence > blockSequence)
        : turn.id === cutTurn.id
          ? []
          : allBlocks;
    if (turn.id === cutTurn.id && metadata.compactedThrough.blockSequence === undefined) continue;
    if (turn.role !== "assistant" || retainedBlocks.length > 0)
      suffix.push({ turn, blocks: retainedBlocks });
  }

  const afterCompaction = turns.filter((turn) => turn.position > compaction.position);
  const ordinal = turns
    .slice(0, turns.indexOf(compaction) + 1)
    .filter((turn) => turn.role === "compaction").length;
  const synthetic = summaryTurn(compaction, props.summary, ordinal);
  const projectedTurns = [
    synthetic.turn,
    ...(pinned ? [pinned] : []),
    ...suffix.map(({ turn }) => turn),
    ...afterCompaction,
  ].map((turn, position) => ({ ...turn, position }));
  const includedTurnIds = new Set(projectedTurns.map((turn) => turn.id));
  const projectedBlocks = [
    synthetic.block,
    ...suffix.flatMap((slice) => slice.blocks),
    ...(pinned ? (blocksByTurn.get(pinned.id) ?? []).filter((block) => !block.pruned) : []),
    ...effectiveBlocks.filter(
      (block) =>
        includedTurnIds.has(block.turnId) &&
        block.turnId !== pinned?.id &&
        !block.pruned &&
        !suffix.some((slice) => slice.turn.id === block.turnId),
    ),
  ];
  return { turns: projectedTurns, blocks: projectedBlocks };
}
