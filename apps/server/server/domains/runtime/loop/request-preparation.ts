/** Request preparation stages references and image decisions without writes, then measures compaction. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Thread, Turn } from "@meridian/contracts/threads";
import {
  encodeImageInclusionMetadata,
  type ImageContextBreak,
  revertedCompactionIds,
} from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import type { Tool } from "../gateway/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import {
  type CompactionDecision,
  CompactionPreparationError,
  decideCompaction,
  type ForcedCompactionDecision,
} from "./compaction/decision.js";
import { type PreparedUndo, prepareCompactionUndo } from "./compaction-undo.js";
import type { ControlMessage } from "./control-barrier.js";
import type { CompactionImageProjectionMode, ImageInclusionDecision } from "./image-context.js";
import { planMessageTurns } from "./inbox-context.js";
import { createLocalTurn } from "./local-turn.js";
import type { OrchestratorDeps, OrchestratorRepositories } from "./orchestrator.js";
import { createPrefixCacheStateService } from "./prefix-cache-state.js";
import { loadReferenceReads } from "./reference-context.js";
import type { DeliverySelection } from "./runtime-delivery.js";
import { type AssembledNextTurnContext, assembleNextTurnContext } from "./turn-context-assembly.js";

export type PrepareRequestInput = {
  deps: OrchestratorDeps;
  thread: Thread;
  threadId: ThreadId;
  referenceTurnId: TurnId;
  currentTurnId: TurnId;
  turns: Turn[];
  blocks: Block[];
  baseTools?: Tool[];
  readReferences?: boolean;
  skipCompaction?: boolean;
  forcedDecision?: ForcedCompactionDecision;
  imageProjectionMode?: CompactionImageProjectionMode;
  controlMessageId?: string;
  controls?: readonly ControlMessage[];
  continueAfterControls?: boolean;
  followingBatches?: DeliverySelection["followingBatches"];
  failedUndoIds?: ReadonlySet<string>;
  assertNoResponseScope?: () => void;
  pinnedRequestTurnIds?: ReadonlySet<string>;
  promptBakes?: OrchestratorRepositories["promptBakes"];
  signal?: AbortSignal;
};
export type PreparedRequest = {
  undos: PreparedUndo[];
  adoptedIds: string[];
  turns: Turn[];
  blocks: Block[];
  assembled: AssembledNextTurnContext;
  events: OrchestratorEvent[];
  compaction: CompactionDecision;
};

export type PreparedControlHistory = Omit<PreparedRequest, "assembled" | "compaction"> & {
  historyTurns: Turn[];
  historyBlocks: Block[];
};
export class UndoRequestPreparationError extends Error {
  constructor(
    readonly prepared: PreparedControlHistory,
    cause: unknown,
  ) {
    super("Request preparation failed after undo", { cause });
  }
  after(leaf: Pick<Turn, "id" | "position"> | null): PreparedControlHistory {
    let previous = leaf;
    for (const turn of this.prepared.turns) {
      turn.prevTurnId = previous?.id ?? null;
      turn.position = nextTurnPosition(previous);
      previous = turn;
    }
    return this.prepared;
  }
}

export function prepareFailedUndoHistory(
  input: PrepareRequestInput,
): Promise<PreparedControlHistory> {
  return prepareControlHistory({
    ...input,
    failedUndoIds: new Set(
      input.controls?.filter((c) => c.body.kind === "compaction_undo").map((c) => c.id),
    ),
  });
}

export async function prepareRequestContext(input: PrepareRequestInput): Promise<PreparedRequest> {
  const history = await prepareControlHistory(input);
  const compact = input.controls?.find((c) => c.body.kind === "compact");
  try {
    const prepared = await prepareBaseRequest({
      ...input,
      turns: history.historyTurns,
      blocks: history.historyBlocks,
      controlMessageId: compact?.id ?? input.controlMessageId,
      skipCompaction:
        !compact &&
        history.undos.length > 0 &&
        (history.undos.some((u) => u.turn.status === "complete") ||
          input.continueAfterControls === false)
          ? true
          : input.skipCompaction,
    });
    return {
      ...prepared,
      ...history,
      events: [...history.events, ...prepared.events],
      turns: [...history.turns, ...prepared.assembled.imageContextUpdates.turns],
      blocks: [...history.blocks, ...prepared.assembled.imageContextUpdates.blocks],
    };
  } catch (error) {
    if (input.signal?.aborted || history.undos.length === 0) throw error;
    if (history.undos.every((u) => u.turn.status === "error"))
      throw new UndoRequestPreparationError(history, error);
    const failedUndoIds = new Set(history.undos.map((u) => u.controlId));
    const failed = await prepareControlHistory({ ...input, failedUndoIds });
    throw new UndoRequestPreparationError(failed, error);
  }
}

async function prepareControlHistory(input: PrepareRequestInput): Promise<PreparedControlHistory> {
  const undos: PreparedUndo[] = [];
  const addedTurns: Turn[] = [];
  const addedBlocks: Block[] = [];
  const events: OrchestratorEvent[] = [];
  const adoptedIds: string[] = [];
  let turns = input.turns;
  let blocks = input.blocks;
  for (const control of input.controls ?? []) {
    if (control.body.kind !== "compaction_undo") continue;
    const following = input.followingBatches?.find((s) => s.afterControlId === control.id);
    const planFollowing = (u: Turn) =>
      planMessageTurns({
        threadId: input.threadId,
        batch: following?.batch ?? [],
        workContext: following?.workContext,
        prevTurnId: u.id,
        prevTurnPosition: u.position,
        knownTurnIds: new Set(turns.map((t) => t.id)),
      });
    const undo = await prepareCompactionUndo({
      ...input,
      turns,
      blocks,
      control,
      forceFailure: input.failedUndoIds?.has(control.id),
      assemble: async (restoredTurns, restoredBlocks) => {
        const plan = planFollowing(restoredTurns.at(-1)!);
        return (
          await prepareBaseRequest({
            ...input,
            turns: [...restoredTurns, ...plan.turns],
            blocks: [...restoredBlocks, ...plan.blocks.map(localBlockFromEvent)],
            skipCompaction: true,
            controlMessageId: undefined,
          })
        ).assembled;
      },
    });
    const { turn } = undo;
    undos.push(undo);
    events.push({
      type: "turn.created",
      turn: turn.status === "complete" ? { ...turn, status: "pending", promptBakeId: null } : turn,
    });
    if (turn.status === "error")
      events.push({
        type: "turn.error",
        turn,
        error: meridianErrorFromSystem(turn.error!, turn.error!),
      });
    const plan = planFollowing(turn);
    events.push(...plan.events);
    const nextTurns = [turn, ...plan.turns];
    const nextBlocks = [
      ...(undo.block ? [localBlockFromEvent(undo.block)] : []),
      ...plan.blocks.map(localBlockFromEvent),
    ];
    addedTurns.push(...nextTurns);
    addedBlocks.push(...nextBlocks);
    turns = [...turns, ...nextTurns];
    blocks = [...blocks, ...nextBlocks];
    adoptedIds.push(...(following?.ackIds ?? []));
  }
  return {
    undos,
    adoptedIds,
    events,
    turns: addedTurns,
    blocks: addedBlocks,
    historyTurns: turns,
    historyBlocks: blocks,
  };
}

async function prepareBaseRequest(
  input: PrepareRequestInput,
): Promise<Omit<PreparedRequest, "undos" | "adoptedIds" | "turns" | "blocks">> {
  const imageProjectionMode =
    input.imageProjectionMode &&
    revertedCompactionIds(input.turns).has(input.imageProjectionMode.decidingTurnId)
      ? undefined
      : input.imageProjectionMode;
  const referenceUpdates =
    input.readReferences === false
      ? []
      : await loadReferenceReads({
          blocks: input.blocks,
          userTurnId: input.referenceTurnId,
          threadId: input.threadId,
          assistantTurnId: input.currentTurnId,
          reader: input.deps.referenceReader,
          signal: input.signal,
        });
  const referencesById = new Map(referenceUpdates.map((block) => [block.id, block]));
  const blocks = input.blocks.map((block) => referencesById.get(block.id) ?? block);
  const events: OrchestratorEvent[] = referenceUpdates.map((block) => ({
    type: "block.upserted",
    block: contentForBlockInput({
      id: block.id,
      turnId: block.turnId as TurnId,
      responseId: block.responseId,
      blockType: block.blockType,
      sequence: block.sequence,
      content: block.content,
      status: "complete",
    }),
  }));
  const assembled = await assembleNextTurnContext({
    thread: input.thread,
    turns: input.turns,
    blocks,
    agentRevisions: input.deps.agentRevisions,
    toolRegistry: input.deps.toolRegistry,
    gateway: input.deps.gateway,
    imageAssets: input.deps.imageAssets,
    imageInclusions: input.deps.repos.imageInclusions,
    imageProjectionMode,
    signal: input.signal,
    baseTools: input.baseTools ?? input.deps.toolExecutor.getDefinitions?.(),
    promptBakes: input.promptBakes ?? input.deps.repos.promptBakes,
    persistBake: false,
    bakeInitialPrompt: input.deps.repos.threads.bakeInitialPrompt.bind(input.deps.repos.threads),
    workContext: input.deps.workContext,
    eventSink: input.deps.eventSink,
    persistImageProjection: async (projection) => {
      const updates = buildImageProjectionEvents({
        threadId: input.threadId,
        afterTurnId: projection.afterTurnId,
        afterTurnPosition: projection.afterTurnPosition,
        imageProjectionMode: projection.imageProjectionMode,
        decisions: projection.decisions,
        breaks: projection.breaks,
      });
      events.push(...updates.events);
      return { turns: updates.turns, blocks: updates.blocks };
    },
  });
  const baseline =
    assembled.compactionTriggerTokens === null || input.skipCompaction
      ? null
      : await createPrefixCacheStateService({ repos: input.deps.repos }).reusableResponseFor({
          threadId: input.threadId,
          model: assembled.resolvedModel,
          knownLocalTurns: input.turns,
        });
  const compactionNeeded =
    !input.skipCompaction &&
    (input.controlMessageId !== undefined ||
      input.forcedDecision !== undefined ||
      assembled.compactionTriggerTokens !== null);
  let compaction: CompactionDecision;
  if (!compactionNeeded) {
    compaction = { kind: "generate" };
  } else {
    const tokenizer = assembled.resolvedModel?.tokenizer;
    if (!tokenizer) {
      throw new Error("Cannot estimate compaction without the resolved thread model tokenizer");
    }
    compaction = decideCompaction({
      request: assembled.generateRequest,
      turns: [...input.turns, ...assembled.imageContextUpdates.turns],
      blocks: [...blocks, ...assembled.imageContextUpdates.blocks],
      thresholdTokens: assembled.compactionTriggerTokens,
      forcedDecision: input.controlMessageId
        ? {
            kind: "compact",
            trigger: "manual",
            fitLimitTokens: assembled.compactionUsableWindowTokens as number,
          }
        : input.forcedDecision,
      controlMessageId: input.controlMessageId,
      pinnedRequestTurnIds: input.pinnedRequestTurnIds,
      summaryReserveTokens: input.deps.summarizer.maxOutputTokens,
      baseline,
      tokenizer,
    });
  }
  if (compaction.kind === "too_large") throw new CompactionPreparationError("context_too_large");
  return { assembled, events, compaction };
}

function buildImageProjectionEvents(input: {
  threadId: ThreadId;
  afterTurnId: TurnId | null;
  afterTurnPosition: number | null;
  imageProjectionMode?: CompactionImageProjectionMode;
  decisions: readonly ImageInclusionDecision[];
  breaks: readonly ImageContextBreak[];
}): { turns: Turn[]; blocks: Block[]; events: OrchestratorEvent[] } {
  const turns: Turn[] = [];
  const blocks: Block[] = [];
  const events: OrchestratorEvent[] = [];
  let decisionTurnId = input.afterTurnId;
  if (input.breaks.length > 0) {
    if (input.afterTurnPosition === null)
      throw new Error("Image context break has no prior position");
    const turn = createLocalTurn({
      threadId: input.threadId,
      position: nextTurnPosition({ position: input.afterTurnPosition }),
      prevTurnId: input.afterTurnId,
      role: "system",
      origin: "system",
      status: "complete",
      metadata: encodeImageInclusionMetadata(input.breaks),
    });
    const block = contentForBlockInput({
      id: turn.id,
      turnId: turn.id,
      blockType: "text",
      sequence: 0,
      textContent: imageContextBreakText(input.breaks),
      status: "complete",
    });
    turns.push(turn);
    blocks.push(localBlockFromEvent(block));
    decisionTurnId = turn.id;
    events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
  }
  if (input.decisions.length > 0 && !decisionTurnId) {
    throw new Error("Image inclusion decisions require a deciding turn");
  }
  for (const { blockId, included, decidedByCompaction } of input.decisions) {
    const decidingTurnId = decidedByCompaction
      ? input.imageProjectionMode?.decidingTurnId
      : decisionTurnId;
    if (!decidingTurnId) throw new Error("Image inclusion decision has no deciding turn");
    events.push({
      type: "image.inclusion_decided",
      threadId: input.threadId,
      blockId,
      decisionTurnId: decidingTurnId as TurnId,
      included,
    });
  }
  return { turns, blocks, events };
}

function imageContextBreakText(breaks: readonly ImageContextBreak[]): string {
  const lines = [
    "Image context changed.",
    ...breaks.map((entry) =>
      entry.reason === "budget_eviction"
        ? `Removed ${entry.uri} to fit the image context budget.`
        : entry.reason === "asset_unavailable"
          ? `The model request no longer includes ${entry.uri} because its asset is unavailable.`
          : `The model could not include ${entry.uri} because its asset is unavailable.`,
    ),
  ];
  return `<system_update>\n${lines.join("\n")}\n</system_update>`;
}
