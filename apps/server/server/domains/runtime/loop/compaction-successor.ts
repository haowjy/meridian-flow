/** Retry-local compaction values and the reusable placeholder completion transaction. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { promptEpochMetadata } from "../../threads/index.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import { resolveAgentThreadTurnContext } from "../tools/agent-thread-context.js";
import { beginPromptEpoch } from "./begin-prompt-epoch.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { type CompactionDecision, CompactionPreparationError } from "./compaction/decision.js";
import { estimateRequestTokens, type projectActiveHistory } from "./compaction/index.js";
import type { InboxDrain } from "./inbox-context.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { persistAndAppendEvents } from "./persistence.js";
import { prepareRequestContext } from "./request-preparation.js";
import { type RunLoopInput, UnsettledPlaceholderError } from "./run-turn-port.js";
import { type AssembledNextTurnContext, composeLivePromptBake } from "./turn-context-assembly.js";

type Decision = Extract<CompactionDecision, { kind: "compact" }>;
export type PreparedCompaction =
  | { kind: "failed"; reason: CompactionPreparationError }
  | {
      kind: "usable";
      composition: Awaited<ReturnType<typeof composeLivePromptBake>>;
      summaryBlock: ReturnType<typeof contentForBlockInput>;
      tokensAfter: number;
      model: string;
      decision: Decision;
      assemble: (turns: Turn[], blocks: Block[]) => ReturnType<typeof prepareRequestContext>;
    };

function fittingTokens(context: AssembledNextTurnContext, fitLimitTokens: number) {
  const tokens = estimateRequestTokens({ request: context.generateRequest, baseline: null });
  if (tokens >= fitLimitTokens) throw new CompactionPreparationError("context_too_large");
  return tokens;
}

export async function prepareCompactionSuccessor(args: {
  deps: OrchestratorDeps;
  input: RunLoopInput;
  thread: Thread;
  placeholder: Turn;
  allTurns: Turn[];
  allBlocks: Block[];
  decision: Decision;
  outcome: SummaryOutcome;
  projection: ReturnType<typeof projectActiveHistory>;
}): Promise<PreparedCompaction> {
  const { deps, input, thread, placeholder, allTurns, allBlocks, decision, outcome, projection } =
    args;
  if (outcome.kind !== "complete")
    return { kind: "failed", reason: new CompactionPreparationError("compaction_failed") };
  try {
    const contextInput = {
      thread,
      turns: allTurns,
      blocks: allBlocks,
      agentRevisions: deps.agentRevisions,
      toolRegistry: deps.toolRegistry,
      baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
      promptBakes: deps.repos.promptBakes,
      workContext: deps.workContext,
    };
    const agentContext = await resolveAgentThreadTurnContext(contextInput);
    const composition = await composeLivePromptBake(contextInput, agentContext);
    const provisionalBakeId = crypto.randomUUID();
    const provisional = {
      ...placeholder,
      status: "complete" as const,
      promptBakeId: provisionalBakeId,
      metadata: promptEpochMetadata(placeholder.metadata, "compaction"),
    };
    const blockInput = {
      turnId: placeholder.id,
      blockType: "custom" as const,
      sequence: 0,
      status: "complete" as const,
    };
    const props = {
      summary: outcome.text,
      model: outcome.model,
      excludedTurnCount: projection.turns.filter(
        (turn) =>
          turn.role !== "compaction" &&
          allTurns.some((raw) => raw.id === turn.id) &&
          !decision.plan.retainedSuffix.some((slice) => slice.turn.id === turn.id),
      ).length,
      tokensBefore: decision.tokensBefore,
    };
    // Projection reads only the summary text; its provisional block is not persisted.
    const projectedSummary = localBlockFromEvent(
      contentForBlockInput({
        ...blockInput,
        content: { kind: "compaction", props: { ...props, tokensAfter: 0 } },
      }),
    );
    const assemble = (lateTurns: Turn[], lateBlocks: Block[]) =>
      prepareRequestContext({
        deps,
        thread,
        threadId: input.threadId,
        referenceTurnId: placeholder.id,
        currentTurnId: placeholder.id,
        turns: [
          ...allTurns.map((turn) => (turn.id === placeholder.id ? provisional : turn)),
          ...lateTurns,
        ],
        blocks: [...allBlocks, projectedSummary, ...lateBlocks],
        baseTools: contextInput.baseTools,
        readReferences: false,
        skipCompaction: true,
        imageProjectionMode: {
          kind: "compaction",
          candidates: new Set(
            decision.plan.retainedSuffix.flatMap(({ blocks }) =>
              blocks.filter((block) => block.blockType === "image").map((block) => block.id),
            ),
          ),
          decidingTurnId: placeholder.id as TurnId,
        },
        signal: input.signal,
        promptBakes: {
          ...deps.repos.promptBakes,
          findById: async (id) =>
            id === provisionalBakeId
              ? {
                  id,
                  ownerThreadId: thread.id,
                  ...composition.bakeContent,
                  createdAt: new Date().toISOString(),
                }
              : deps.repos.promptBakes.findById(id),
        },
      });
    const base = await assemble([], []);
    const tokensAfter = fittingTokens(base.assembled, decision.fitLimitTokens);
    const summaryBlock = contentForBlockInput({
      ...blockInput,
      content: { kind: "compaction", props: { ...props, tokensAfter } },
    });
    return {
      kind: "usable",
      composition,
      summaryBlock,
      tokensAfter,
      model: outcome.model,
      decision,
      assemble,
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      kind: "failed",
      reason:
        error instanceof CompactionPreparationError
          ? error
          : new CompactionPreparationError("compaction_failed"),
    };
  }
}

export async function prepareCompactionContext(
  drain: InboxDrain,
  prepared: PreparedCompaction | undefined,
) {
  if (!prepared) throw new Error("Missing prepared compaction");
  if (prepared.kind === "failed") throw prepared.reason;
  const next = await prepared.assemble(drain.turns, drain.blocks);
  fittingTokens(next.assembled, prepared.decision.fitLimitTokens);
  return {
    events: next.events,
    turns: next.assembled.imageContextUpdates.turns,
    blocks: next.assembled.imageContextUpdates.blocks,
    requiresSplit: true,
    context: next.assembled,
  };
}

/** Caller holds the delivery transaction. Failure and success settle the same paid rows. */
export async function completeCompactionCurrent(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  placeholder: Turn;
  prepared: PreparedCompaction | undefined;
  failure: unknown;
  settleResponses: () => Promise<void>;
}): Promise<Turn> {
  const { deps, threadId, placeholder, prepared } = input;
  await input.settleResponses();
  const settled = await deps.repos.turns.findById(placeholder.id);
  if (!settled) throw new Error("Compaction placeholder disappeared");
  if (prepared?.kind === "usable") {
    await beginPromptEpoch(deps, {
      threadId,
      cause: "compaction",
      boundaryTurnId: placeholder.id,
      bake: { compose: prepared.composition.bakeContent },
      completion: {
        blocks: [prepared.summaryBlock],
        compactionModel: prepared.model,
        metadata: promptEpochMetadata(settled.metadata, "compaction"),
        events: (bakeId) => [
          {
            type: "context.compacted",
            compactionTurnId: placeholder.id,
            compactedThrough: prepared.decision.plan.compactedThrough,
            bakeId,
            model: prepared.model,
            tokensBefore: prepared.decision.tokensBefore,
            tokensAfter: prepared.tokensAfter,
          },
        ],
      },
    });
  } else {
    const failed = {
      ...settled,
      status: "error" as const,
      error: "This conversation couldn't be compacted. Try again.",
      completedAt: new Date().toISOString(),
    };
    await persistAndAppendEvents(deps, threadId, async () => ({
      result: undefined,
      events: [
        {
          type: "turn.error",
          turn: failed,
          error: meridianErrorFromSystem(
            prepared?.kind === "failed"
              ? prepared.reason.reason
              : input.failure instanceof CompactionPreparationError
                ? input.failure.reason
                : "compaction_failed",
            failed.error,
          ),
        },
      ],
    }));
  }
  const turn = await deps.repos.turns.findById(placeholder.id);
  if (!turn) throw new Error("Compaction placeholder disappeared");
  return turn;
}

/** One live failure landing; caller can reuse it without running a summary phase. */
export async function failCompactionSuccessor(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  placeholder: Turn;
  boundary: import("./runtime-delivery.js").DeliveryBoundary;
  settleResponses: () => Promise<void>;
}) {
  const reason = new CompactionPreparationError("compaction_failed");
  try {
    return await input.deps.delivery.splitAndContinue<PreparedCompaction>({
      ...input.boundary,
      prepareCurrent: async () => ({ kind: "failed", reason }),
      prepareNextContext: prepareCompactionContext,
      current: {
        kind: "placeholder",
        complete: (prepared, failure) => completeCompactionCurrent({ ...input, prepared, failure }),
      },
    });
  } catch (error) {
    throw new UnsettledPlaceholderError(error);
  }
}
