import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
/** Request preparation stages references and image decisions without writes, then measures compaction. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Thread, Turn } from "@meridian/contracts/threads";
import { encodeImageInclusionMetadata, type ImageContextBreak } from "../../threads/index.js";
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
import { createLocalTurn } from "./local-turn.js";
import type { OrchestratorDeps, OrchestratorRepositories } from "./orchestrator.js";
import { createPrefixCacheStateService } from "./prefix-cache-state.js";
import { loadReferenceReads } from "./reference-context.js";
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
  failedUndoIds?: ReadonlySet<string>;
  assertNoResponseScope?: () => void;
  pinnedRequestTurnIds?: ReadonlySet<string>;
  promptBakes?: OrchestratorRepositories["promptBakes"];
  signal?: AbortSignal;
};
export type PreparedRequest = {
  undos: PreparedUndo[];
  turns: Turn[];
  blocks: Block[];
  assembled: AssembledNextTurnContext;
  events: OrchestratorEvent[];
  compaction: CompactionDecision;
};

export async function prepareRequestContext(input: PrepareRequestInput): Promise<PreparedRequest> {
  const undos: PreparedUndo[] = [];
  let turns = input.turns;
  let blocks = input.blocks;
  for (const control of input.controls ?? []) {
    if (control.body.kind !== "compaction_undo") continue;
    const undo = await prepareCompactionUndo({
      ...input,
      turns,
      blocks,
      control,
      forceFailure: input.failedUndoIds?.has(control.id),
      assemble: async (turns, blocks) =>
        (
          await prepareBaseRequest({
            ...input,
            turns,
            blocks,
            skipCompaction: true,
            controlMessageId: undefined,
          })
        ).assembled,
    });
    undos.push(undo);
    turns = [...turns, undo.turn];
    if (undo.block) blocks = [...blocks, localBlockFromEvent(undo.block)];
  }
  const compact = input.controls?.find((c) => c.body.kind === "compact");
  const prepared = await prepareBaseRequest({
    ...input,
    turns,
    blocks,
    controlMessageId: compact?.id ?? input.controlMessageId,
    skipCompaction: undos.length > 0 && !compact ? true : input.skipCompaction,
  });
  return {
    ...prepared,
    undos,
    events: [
      ...undos.flatMap(({ turn }): OrchestratorEvent[] => [
        {
          type: "turn.created",
          turn:
            turn.status === "complete" ? { ...turn, status: "pending", promptBakeId: null } : turn,
        },
        ...(turn.status === "error"
          ? [
              {
                type: "turn.error" as const,
                turn,
                error: meridianErrorFromSystem(turn.error!, turn.error!),
              },
            ]
          : []),
      ]),
      ...prepared.events,
    ],
    turns: [...undos.map((u) => u.turn), ...prepared.assembled.imageContextUpdates.turns],
    blocks: [
      ...undos.flatMap((u) => (u.block ? [localBlockFromEvent(u.block)] : [])),
      ...prepared.assembled.imageContextUpdates.blocks,
    ],
  };
}

async function prepareBaseRequest(
  input: PrepareRequestInput,
): Promise<Omit<PreparedRequest, "undos" | "turns" | "blocks">> {
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
    imageProjectionMode: input.imageProjectionMode,
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
