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
import { estimateRequestTokens } from "./compaction/estimate.js";
import { prepareCompactionHeadsUp } from "./compaction/heads-up.js";
import { projectActiveHistoryWithBakes } from "./compaction/index.js";
import { frontierLookup } from "./frontier-recording.js";
import type { CompactionImageProjectionMode, ImageInclusionDecision } from "./image-context.js";
import { createLocalTurn } from "./local-turn.js";
import type { ControlMessage } from "./next-inbox-work.js";
import type { OrchestratorDeps, OrchestratorRepositories } from "./orchestrator.js";
import { createPrefixCacheStateService } from "./prefix-cache-state.js";
import {
  type LoadedReferenceReads,
  loadReferenceReads,
  NO_REFERENCE_EVIDENCE,
  type ReferenceEvidence,
} from "./reference-context.js";
import {
  type AssembledNextTurnContext,
  type AssembleNextTurnContextInput,
  assembleNextTurnContext,
} from "./turn-context-assembly.js";

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
  instructions?: string;
  control?: ControlMessage | null;
  assertNoResponseScope?: () => void;
  pinnedRequestTurnIds?: ReadonlySet<string>;
  promptBakes?: OrchestratorRepositories["promptBakes"];
  signal?: AbortSignal;
};
export type PreparedRequest = {
  turns: Turn[];
  blocks: Block[];
  assembled: AssembledNextTurnContext;
  events: OrchestratorEvent[];
  compaction: CompactionDecision;
  /** Host-only reference-read evidence; the commit persisting `events` records it. */
  evidence: ReferenceEvidence;
};

export async function prepareRequestContext(input: PrepareRequestInput): Promise<PreparedRequest> {
  const control = input.control;
  const compact = control?.body.kind === "compact" ? { id: control.id, body: control.body } : null;
  return prepareBaseRequest({
    ...input,
    controlMessageId: compact?.id ?? input.controlMessageId,
    instructions: compact?.body.instructions ?? input.instructions,
  });
}

async function prepareBaseRequest(input: PrepareRequestInput): Promise<PreparedRequest> {
  // Projected on first use and shared by every lookup: most runs read no reference at all.
  let creditedIds: Promise<string[]> | undefined;
  const requestCreditedIds = () =>
    (creditedIds ??= projectActiveHistoryWithBakes(
      input.turns,
      input.blocks,
      input.thread.ref,
      input.promptBakes ?? input.deps.repos.promptBakes,
    ).then((projection) => [...projection.creditedBlockIds]));
  const references: LoadedReferenceReads =
    input.readReferences === false
      ? { blocks: [], evidence: NO_REFERENCE_EVIDENCE }
      : await loadReferenceReads({
          blocks: input.blocks,
          userTurnId: input.referenceTurnId,
          threadId: input.threadId,
          assistantTurnId: input.currentTurnId,
          reader: input.deps.referenceReader,
          signal: input.signal,
          // The read is shown beside what this request carries, so only that credits it (C10).
          recordingFrontier: frontierLookup(input.deps, requestCreditedIds, {
            threadId: input.threadId,
            turnId: input.currentTurnId,
          }),
        });
  const referenceUpdates = references.blocks;
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
  const assemblyInput: AssembleNextTurnContextInput = {
    thread: input.thread,
    turns: input.turns,
    blocks,
    agentRevisions: input.deps.agentRevisions,
    threads: input.deps.repos.threads,
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
  };
  let assembled = await assembleNextTurnContext(assemblyInput);
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
    const threadModel = assembled.resolvedModel;
    if (!threadModel?.tokenizer) {
      throw new Error("Cannot estimate compaction without the resolved thread model tokenizer");
    }
    const tokenizer = threadModel.tokenizer;
    compaction = decideCompaction({
      request: assembled.generateRequest,
      activeHistory: assembled.activeHistory,
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
      instructions: input.instructions,
      pinnedRequestTurnIds: input.pinnedRequestTurnIds,
      baseline,
      tokenizer,
    });
  }
  const automaticCompactionCannotFit =
    compaction.kind === "too_large" ||
    (compaction.kind === "compact" && compaction.trigger === "auto" && !!compaction.refusal);
  if (automaticCompactionCannotFit) {
    const usableWindowTokens = assembled.compactionUsableWindowTokens;
    const tokenizer = assembled.resolvedModel?.tokenizer;
    if (!tokenizer) throw new Error("Cannot measure request size without a resolved tokenizer");
    const requestTokens = estimateRequestTokens({
      request: assembled.generateRequest,
      baseline,
      tokenizer,
    });
    if (
      input.controlMessageId !== undefined ||
      input.forcedDecision !== undefined ||
      usableWindowTokens === null ||
      requestTokens >= usableWindowTokens
    ) {
      throw new CompactionPreparationError("context_too_large");
    }
    compaction = { kind: "generate" };
  }
  const updates = {
    turns: [...assembled.imageContextUpdates.turns],
    blocks: [...assembled.imageContextUpdates.blocks],
  };
  const threshold = assembled.compactionTriggerTokens;
  const tokenizer = assembled.resolvedModel?.tokenizer;
  if (
    compaction.kind === "generate" &&
    !input.skipCompaction &&
    threshold !== null &&
    tokenizer &&
    estimateRequestTokens({ request: assembled.generateRequest, baseline, tokenizer }) >=
      Math.floor(0.85 * threshold)
  ) {
    const imageUpdates = assembled.imageContextUpdates;
    const headsUp = prepareCompactionHeadsUp({
      threadId: input.threadId,
      turns: [...input.turns, ...imageUpdates.turns],
    });
    if (headsUp.turns.length > 0) {
      events.push(...headsUp.events);
      // Render the durable suffix through the ordinary history path, including user merging
      // and cache marks. Image decisions were already staged by the first assembly.
      assembled = await assembleNextTurnContext({
        ...assemblyInput,
        turns: [...input.turns, ...imageUpdates.turns, ...headsUp.turns],
        blocks: [...blocks, ...imageUpdates.blocks, ...headsUp.blocks],
        persistImageProjection: undefined,
      });
      updates.turns.push(...headsUp.turns);
      updates.blocks.push(...headsUp.blocks);
    }
  }
  return { ...updates, assembled, events, compaction, evidence: references.evidence };
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
