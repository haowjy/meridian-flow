/** Retry-local compaction values and the reusable placeholder completion transaction. */
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, Thread, Turn } from "@meridian/contracts/threads";
import { promptEpochMetadata } from "../../threads/index.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import { resolveAgentThreadTurnContext } from "../tools/agent-thread-context.js";
import { beginPromptEpoch } from "./begin-prompt-epoch.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import {
  type CompactionDecision,
  CompactionFailureError,
  type CompactionFailureOutcome,
  type CompactionFailurePhase,
  compactionFailureFrom,
  compactionFailureMessage,
  summaryCompactionFailure,
} from "./compaction/decision.js";
import { collectRecordedDocuments, planModelElisions } from "./compaction/elide.js";
import { estimateRequestTokens, type projectActiveHistory } from "./compaction/index.js";
import { queryCompactionRevisions } from "./compaction-revisions.js";
import type { InboxDrain } from "./inbox-context.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { persistAndAppendEvents } from "./persistence.js";
import { prepareRequestContext } from "./request-preparation.js";
import { type RunLoopInput, UnsettledPlaceholderError } from "./run-turn-port.js";
import { type AssembledNextTurnContext, composeLivePromptBake } from "./turn-context-assembly.js";

type Decision = Extract<CompactionDecision, { kind: "compact" }>;
export type PreparedCompaction =
  | { kind: "failed"; failure: CompactionFailureOutcome }
  | {
      kind: "usable";
      metadata: JsonObject;
      provisionalBakeId: string;
      composition: Awaited<ReturnType<typeof composeLivePromptBake>>;
      summaryBlock: ReturnType<typeof contentForBlockInput>;
      tokensAfter: number;
      model: string;
      decision: Decision;
      assemble: (
        turns: Turn[],
        blocks: Block[],
        selection?: import("./runtime-delivery.js").DeliverySelection,
      ) => ReturnType<typeof prepareRequestContext>;
    };

function fittingTokens(
  context: AssembledNextTurnContext,
  fitLimitTokens: number,
  phase: CompactionFailurePhase,
) {
  const tokenizer = context.resolvedModel?.tokenizer;
  if (!tokenizer) throw new Error("Cannot estimate compaction successor without a model tokenizer");
  const tokens = estimateRequestTokens({
    request: context.generateRequest,
    baseline: null,
    tokenizer,
  });
  if (tokens >= fitLimitTokens)
    throw new CompactionFailureError({
      reason: "context_too_large",
      phase,
      estimatedTokens: tokens,
      fitLimitTokens,
    });
  return tokens;
}

export async function prepareCompactionSuccessor(args: {
  deps: OrchestratorDeps;
  assertNoResponseScope: () => void;
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
  if (decision.refusal)
    return {
      kind: "failed",
      failure: {
        reason: decision.refusal,
        phase: "initial_prepare",
        ...(decision.refusal === "context_too_large"
          ? {
              estimatedTokens: decision.tokensBefore,
              fitLimitTokens: decision.fitLimitTokens,
            }
          : {}),
      },
    };
  if (outcome.kind !== "complete")
    return {
      kind: "failed",
      failure:
        outcome.kind === "failed"
          ? summaryCompactionFailure(outcome.rejectionReason)
          : summaryCompactionFailure(undefined),
    };
  try {
    const policies = (name: string) => deps.toolRegistry.getRegistration(name)?.documentText;
    const recorded = collectRecordedDocuments(decision.plan.retainedSuffix, policies);
    const current = await queryCompactionRevisions({
      threadId: input.threadId,
      recorded,
      revisions: deps.documentRevisions,
      assertNoResponseScope: args.assertNoResponseScope,
    });
    const elisions = planModelElisions({
      retainedSuffix: decision.plan.retainedSuffix,
      recorded,
      current,
      policies,
    });
    const metadata = { ...(placeholder.metadata as JsonObject), elisions };
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
      metadata: promptEpochMetadata(metadata, "compaction"),
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
    const assemble = (
      lateTurns: Turn[],
      lateBlocks: Block[],
      selection?: import("./runtime-delivery.js").DeliverySelection,
    ) =>
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
        imageProjectionMode: {
          kind: "compaction",
          candidates: new Set(
            decision.plan.retainedSuffix.flatMap(({ blocks }) =>
              blocks.filter((block) => block.blockType === "image").map((block) => block.id),
            ),
          ),
          decidingTurnId: placeholder.id as TurnId,
        },
        skipCompaction: !selection?.control,
        controlMessageId: selection?.control?.id,
        pinnedRequestTurnIds: new Set(selection?.outstanding.map((row) => row.id)),
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
    const tokensAfter = fittingTokens(base.assembled, decision.fitLimitTokens, "initial_prepare");
    const summaryBlock = contentForBlockInput({
      ...blockInput,
      content: { kind: "compaction", props: { ...props, tokensAfter } },
    });
    return {
      kind: "usable",
      metadata,
      provisionalBakeId,
      composition,
      summaryBlock,
      tokensAfter,
      model: outcome.model,
      decision,
      assemble,
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { kind: "failed", failure: compactionFailureFrom(error, "initial_prepare") };
  }
}

export async function prepareCompactionContext(
  drain: InboxDrain,
  prepared: PreparedCompaction | undefined,
) {
  if (!prepared) throw new Error("Missing prepared compaction");
  if (prepared.kind === "failed") throw new CompactionFailureError(prepared.failure);
  const next = await prepared.assemble(drain.turns, drain.blocks);
  try {
    fittingTokens(next.assembled, prepared.decision.fitLimitTokens, "late_arrival");
  } catch (error) {
    throw new CompactionFailureError(compactionFailureFrom(error, "late_arrival"));
  }
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
  satisfiesControlId?: string;
}): Promise<Turn> {
  const { deps, threadId, placeholder, prepared } = input;
  await input.settleResponses();
  const settled = await deps.repos.turns.findById(placeholder.id);
  if (!settled) throw new Error("Compaction placeholder disappeared");
  if (input.satisfiesControlId) {
    settled.metadata = {
      ...(settled.metadata as import("@meridian/contracts/threads").JsonObject),
      satisfiesControlId: input.satisfiesControlId,
    };
    await deps.repos.turns.updateStatus(settled.id, {
      status: settled.status,
      metadata: settled.metadata,
    });
  }
  const deliveryFailure =
    input.failure === undefined ? undefined : compactionFailureFrom(input.failure, "delivery");
  const failure =
    prepared?.kind === "failed"
      ? prepared.failure
      : prepared?.kind === "usable" && deliveryFailure?.phase === "delivery"
        ? undefined
        : deliveryFailure;
  if (prepared?.kind === "usable" && failure === undefined) {
    await beginPromptEpoch(deps, {
      threadId,
      cause: "compaction",
      boundaryTurnId: placeholder.id,
      bake: { compose: prepared.composition.bakeContent },
      completion: {
        blocks: [prepared.summaryBlock],
        compactionModel: prepared.model,
        metadata: { ...(settled.metadata as JsonObject), ...prepared.metadata },
        events: (bakeId) => [
          {
            type: "context.compacted",
            compactionTurnId: placeholder.id,
            compactedThrough: prepared.decision.plan.compactedThrough as NonNullable<
              Decision["plan"]["compactedThrough"]
            >,
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
      error: compactionFailureMessage(failure?.reason ?? "compaction_failed"),
      metadata: {
        ...(settled.metadata as import("@meridian/contracts/threads").JsonObject),
        reason: failure?.reason ?? "compaction_failed",
        phase: failure?.phase ?? "delivery",
        ...(failure?.estimatedTokens === undefined
          ? {}
          : { estimatedTokens: failure.estimatedTokens }),
        ...(failure?.fitLimitTokens === undefined
          ? {}
          : { fitLimitTokens: failure.fitLimitTokens }),
      },
      completedAt: new Date().toISOString(),
    };
    await persistAndAppendEvents(deps, threadId, async () => ({
      result: undefined,
      events: [
        {
          type: "turn.error",
          turn: failed,
          error: meridianErrorFromSystem(failure?.reason ?? "compaction_failed", failed.error),
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
  optional?: boolean;
  settleResponses: () => Promise<void>;
  failure: unknown;
}) {
  const failure = compactionFailureFrom(input.failure, "delivery");
  try {
    return await input.deps.delivery.splitAndContinue<PreparedCompaction>({
      ...input.boundary,
      prepareCurrent: async () => ({ kind: "failed", failure }),
      prepareNextContext: input.optional
        ? (drain, _prepared, selection) =>
            input.boundary.prepareNextContext(drain, undefined, selection)
        : prepareCompactionContext,
      current: {
        kind: "placeholder",
        complete: (prepared, failure) => completeCompactionCurrent({ ...input, prepared, failure }),
      },
    });
  } catch (error) {
    throw new UnsettledPlaceholderError(error);
  }
}
