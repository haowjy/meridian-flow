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
} from "./compaction/decision.js";
import type { ImageInclusionDecision } from "./image-context.js";
import { createLocalTurn } from "./local-turn.js";
import type { OrchestratorDeps, OrchestratorRepositories } from "./orchestrator.js";
import { createPrefixCacheStateService } from "./prefix-cache-state.js";
import { loadReferenceReads } from "./reference-context.js";
import { type AssembledNextTurnContext, assembleNextTurnContext } from "./turn-context-assembly.js";

export async function prepareRequestContext(input: {
  deps: OrchestratorDeps;
  thread: Thread;
  threadId: ThreadId;
  referenceUserTurnId: TurnId;
  assistantTurnId: TurnId;
  turns: Turn[];
  blocks: Block[];
  baseTools?: Tool[];
  readReferences?: boolean;
  skipCompaction?: boolean;
  promptBakes?: OrchestratorRepositories["promptBakes"];
  signal?: AbortSignal;
}): Promise<{
  assembled: AssembledNextTurnContext;
  events: OrchestratorEvent[];
  compaction: CompactionDecision;
}> {
  const referenceUpdates =
    input.readReferences === false
      ? []
      : await loadReferenceReads({
          blocks: input.blocks,
          userTurnId: input.referenceUserTurnId,
          threadId: input.threadId,
          assistantTurnId: input.assistantTurnId,
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
  const compaction = input.skipCompaction
    ? { kind: "generate" as const }
    : decideCompaction({
        request: assembled.generateRequest,
        turns: [...input.turns, ...assembled.imageContextUpdates.turns],
        blocks: [...blocks, ...assembled.imageContextUpdates.blocks],
        thresholdTokens: assembled.compactionTriggerTokens,
        summaryReserveTokens: input.deps.summarizer.maxOutputTokens,
        baseline,
      });
  if (compaction.kind === "too_large") throw new CompactionPreparationError("context_too_large");
  return { assembled, events, compaction };
}

function buildImageProjectionEvents(input: {
  threadId: ThreadId;
  afterTurnId: TurnId | null;
  afterTurnPosition: number | null;
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
  events.push(
    ...input.decisions.map(({ blockId, included }) => ({
      type: "image.inclusion_decided" as const,
      threadId: input.threadId,
      blockId,
      decisionTurnId: decisionTurnId as TurnId,
      included,
    })),
  );
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
