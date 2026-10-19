/** Request preparation stages references and image decisions without writes, then measures compaction. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Thread, Turn } from "@meridian/contracts/threads";
import {
  activeCompaction,
  encodeImageInclusionMetadata,
  type ImageContextBreak,
  isCompactionNotesTurn,
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
import { estimateRequestTokens } from "./compaction/estimate.js";
import { projectActiveHistoryWithBakes } from "./compaction/index.js";
import {
  MAX_NOTES_ALLOWANCE_TOKENS,
  MAX_NOTES_ITERATIONS,
  MIN_NOTES_ALLOWANCE_TOKENS,
  NOTES_RESERVE_TOKENS,
  type NotesContinuation,
  prepareCompactionNotes,
} from "./compaction/notes-step.js";
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
  prepareNextTurnContext,
  renderPreparedTurnContext,
} from "./turn-context-assembly.js";

export type PrepareRequestInput = {
  continuation?: NotesContinuation;
  remainingIterations?: number;
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
export type PreparedContinuation = {
  assembled: AssembledNextTurnContext;
  continuation: NotesContinuation;
};
export type PreparedRequest = {
  continuation: NotesContinuation;
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
  const prepared = await prepareNextTurnContext(assemblyInput);
  let assembled = renderPreparedTurnContext(prepared);
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
      turns: [...input.turns, ...assembled.preparationUpdates.turns],
      blocks: [...blocks, ...assembled.preparationUpdates.blocks],
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
    turns: [...assembled.preparationUpdates.turns],
    blocks: [...assembled.preparationUpdates.blocks],
  };
  let continuation: NotesContinuation = { kind: "ordinary" };
  const current = input.continuation ?? continuation;
  const tokenizer = assembled.resolvedModel?.tokenizer;
  const usable = assembled.compactionUsableWindowTokens;
  const remaining = input.remainingIterations ?? 0;
  const measure = () => {
    if (!tokenizer) throw new Error("Notes measurement requires the thread tokenizer");
    return estimateRequestTokens({ request: assembled.generateRequest, baseline: null, tokenizer });
  };
  if (current.kind === "notes" && !input.forcedDecision && !input.controlMessageId) {
    const measured = measure();
    if (
      current.remaining > 0 &&
      usable !== null &&
      measured - current.entryTokens < current.allowance &&
      measured <= usable - NOTES_RESERVE_TOKENS
    ) {
      continuation = current;
      compaction = { kind: "generate" };
    }
  } else if (
    current.kind === "ordinary" &&
    compaction.kind === "compact" &&
    compaction.trigger === "auto" &&
    !compaction.knownTooLarge &&
    !input.forcedDecision &&
    !input.controlMessageId &&
    !input.skipCompaction &&
    remaining >= 2 &&
    usable !== null
  ) {
    const latest = activeCompaction(input.turns);
    const since = input.turns.filter((turn) => !latest || turn.position > latest.position);
    if (!since.some(isCompactionNotesTurn)) {
      const entryTokens = measure();
      const allowance = Math.min(
        MAX_NOTES_ALLOWANCE_TOKENS,
        usable - entryTokens - NOTES_RESERVE_TOKENS,
      );
      const responseTurns = since
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turn.id);
      // Empty reservations and split-only assistants are not ordinary model progress.
      if (
        allowance >= MIN_NOTES_ALLOWANCE_TOKENS &&
        responseTurns.length > 0 &&
        (await input.deps.repos.modelResponses.findLatestForTurns(responseTurns))
      ) {
        const marker = prepareCompactionNotes({
          threadId: input.threadId,
          turns: [...input.turns, ...assembled.preparationUpdates.turns],
        });
        const candidate = renderPreparedTurnContext({
          ...prepared,
          activeHistory: {
            turns: [...prepared.activeHistory.turns, ...marker.turns],
            blocks: [...prepared.activeHistory.blocks, ...marker.blocks],
          },
          preparationUpdates: {
            turns: [...assembled.preparationUpdates.turns, ...marker.turns],
            blocks: [...assembled.preparationUpdates.blocks, ...marker.blocks],
          },
        });
        if (!tokenizer) throw new Error("Notes measurement requires the thread tokenizer");
        const candidateTokens = estimateRequestTokens({
          request: candidate.generateRequest,
          baseline: null,
          tokenizer,
        });
        if (
          candidateTokens - entryTokens < allowance &&
          candidateTokens <= usable - NOTES_RESERVE_TOKENS
        ) {
          assembled = candidate;
          events.push(...marker.events);
          updates.turns.push(...marker.turns);
          updates.blocks.push(...marker.blocks);
          continuation = {
            kind: "notes",
            remaining: Math.min(MAX_NOTES_ITERATIONS, remaining - 1),
            entryTokens,
            allowance,
          };
          compaction = { kind: "generate" };
        }
      }
    }
  }
  return {
    ...updates,
    assembled,
    continuation,
    events,
    compaction,
    evidence: references.evidence,
  };
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
