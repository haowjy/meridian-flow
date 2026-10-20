/** Retry-local compaction values and the reusable placeholder completion transaction. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, Thread, Turn } from "@meridian/contracts/threads";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  compactionFailureMetadata,
  promptEpochMetadata,
  turnFailedCopy,
} from "../../threads/index.js";
import { orderTurnsByPosition } from "../../threads/order-turns.js";
import type { TokenizerFamily } from "../gateway/index.js";
import type { SummaryOutcome } from "../ports/conversation-summarizer.js";
import { resolveAgentThreadTurnContext } from "../tools/agent-thread-context.js";
import type { DocumentTextPolicy } from "../tools/document-text.js";
import { beginPromptEpoch } from "./begin-prompt-epoch.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import {
  type CompactionDecision,
  CompactionFailureError,
  type CompactionFailureOutcome,
  compactionFailureDiagnosticMessage,
  compactionFailureFrom,
  compactionFailureMeridianError,
  summaryCompactionFailure,
} from "./compaction/decision.js";
import { collectRecordedDocuments, planModelElisions } from "./compaction/elide.js";
import {
  chooseImportantFiles,
  documentsSection,
  importantFileCandidates,
  importantFileLabel,
  parseImportantFiles,
  reshowBudgetTokens,
} from "./compaction/important-files.js";
import { estimateRequestTokens, type ProjectedActiveHistory } from "./compaction/index.js";
import { queryCompactionRevisions } from "./compaction-revisions.js";
import type { InboxDrain } from "./inbox-context.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { persistAndAppendEvents } from "./persistence.js";
import {
  NO_REFERENCE_EVIDENCE,
  type ReferenceEvidence,
  recordReferenceEvidence,
  referenceReadText,
} from "./reference-context.js";
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
      /** The documents the compaction re-shows after its summary, persisted on its turn. */
      reshown: ReshownDocuments;
      tokensAfter: number;
      model: string;
      decision: Decision;
      assemble: (
        turns: Turn[],
        blocks: Block[],
        selection?: import("./runtime-delivery.js").DeliveryBoundarySelection,
      ) => ReturnType<typeof prepareRequestContext>;
    };

interface ReshownDocuments {
  blocks: ReturnType<typeof contentForBlockInput>[];
  /** Recorded with the blocks: a fresh frontier chain, like an @-mentioned document's. */
  evidence: ReferenceEvidence;
  /** Documents whose whole text was re-shown: only their copies are elided from the tail. */
  fullyReshownDocumentIds: ReadonlySet<string>;
  /** The admitted labels, in read order: the summary's list after the reads. */
  labels: string[];
}

const NO_RESHOWN: ReshownDocuments = {
  blocks: [],
  evidence: NO_REFERENCE_EVIDENCE,
  fullyReshownDocumentIds: new Set(),
  labels: [],
};

function fittingEstimate(context: AssembledNextTurnContext) {
  const tokenizer = context.resolvedModel?.tokenizer;
  if (!tokenizer)
    throw new CompactionFailureError({ reason: "compaction_failed", phase: "initial_prepare" });
  const fitLimitTokens = context.compactionUsableWindowTokens;
  if (fitLimitTokens === null)
    throw new CompactionFailureError({ reason: "compaction_failed", phase: "initial_prepare" });
  const tokens = estimateRequestTokens({
    request: context.generateRequest,
    baseline: null,
    tokenizer,
  });
  if (tokens >= fitLimitTokens)
    throw new CompactionFailureError({
      reason: "context_too_large",
      phase: "initial_prepare",
      estimatedTokens: tokens,
      fitLimitTokens,
    });
  return { tokens, tokenizer };
}

/**
 * Reads the pre-compaction history's model-ranked selections and recent documents, through the
 * reference reader (the server's one read door), each as a block on the compaction turn with
 * evidence recorded like an @-mentioned document's: a frontier chained from nothing.
 */
async function reshowImportantFiles(args: {
  deps: OrchestratorDeps;
  assertNoResponseScope: () => void;
  input: RunLoopInput;
  placeholder: Turn;
  allTurns: Turn[];
  allBlocks: Block[];
  policies: (name: string) => DocumentTextPolicy | undefined;
  budgetTokens: number;
  tokenizer: TokenizerFamily;
  listedLines: readonly string[];
}): Promise<ReshownDocuments> {
  const { deps, input, placeholder, allBlocks } = args;
  const blocksByTurn = new Map<string, Block[]>();
  for (const block of allBlocks) {
    const blocks = blocksByTurn.get(block.turnId) ?? [];
    blocks.push(block);
    blocksByTurn.set(block.turnId, blocks);
  }
  const history = orderTurnsByPosition(args.allTurns).map((turn) => ({
    turn,
    blocks: blocksByTurn.get(turn.id) ?? [],
  }));
  const { candidates, unknownUriCount } = importantFileCandidates(
    collectRecordedDocuments(history, args.policies),
    args.listedLines,
  );
  if (unknownUriCount > 0) {
    emitEvent(deps.eventSink, {
      level: "debug",
      source: "runtime.compaction",
      name: "important_file.unknown_uris",
      correlation: { threadId: input.threadId, turnId: placeholder.id },
      payload: { count: unknownUriCount },
    });
  }
  const kept = await chooseImportantFiles({
    candidates,
    budgetTokens: args.budgetTokens,
    tokenizer: args.tokenizer,
    read: async (reference, selector) => {
      args.assertNoResponseScope();
      input.signal?.throwIfAborted();
      try {
        const read = await deps.referenceReader.read(reference, {
          threadId: input.threadId,
          turnId: placeholder.id,
          ...(input.signal ? { signal: input.signal } : {}),
          recordingFrontier: async () => null,
          ...(selector ? { selector } : {}),
        });
        input.signal?.throwIfAborted();
        return read.evidence ? { ...read, text: referenceReadText(read.result) } : null;
      } catch (error) {
        // A document that cannot be re-shown costs the compaction nothing but that document.
        if (input.signal?.aborted) throw error;
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "runtime.compaction",
          name: "important_file.read_failed",
          correlation: { threadId: input.threadId, turnId: placeholder.id },
          payload: unknownToEventPayload(error),
        });
        return null;
      }
    },
  });
  const documentIds = new Set(kept.map(({ reference }) => reference.documentId));
  const blocks = kept.map(({ reference, selector, read }, index) =>
    contentForBlockInput({
      turnId: placeholder.id,
      blockType: "text",
      sequence: index + 1,
      status: "complete",
      content: {
        ...reference,
        read: { result: read.result, revision: read.revision, ...(selector ? { selector } : {}) },
      },
    }),
  );
  return {
    blocks,
    evidence: {
      shown: kept.flatMap(({ read }) => read.evidence?.shown ?? []),
      frontiers: kept.flatMap(({ read }, index) =>
        read.evidence?.frontier
          ? [{ sourceBlockId: blocks[index]?.id as string, frontier: read.evidence.frontier }]
          : [],
      ),
    },
    fullyReshownDocumentIds: new Set(
      kept.filter(({ selector }) => !selector).map(({ reference }) => reference.documentId),
    ),
    labels: kept.map(({ reference, selector }) =>
      importantFileLabel({ uri: reference.uri, selector }),
    ),
  };
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
  projection: ProjectedActiveHistory;
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
  const parsed = parseImportantFiles(outcome.text);
  if (!parsed.summary) return { kind: "failed", failure: summaryCompactionFailure("empty_text") };
  try {
    const policies = (name: string) => deps.toolRegistry.getRegistration(name)?.documentText;
    const recorded = collectRecordedDocuments(decision.plan.retainedSuffix, policies);
    const current = await queryCompactionRevisions({
      threadId: input.threadId,
      recorded,
      revisions: deps.documentRevisions,
      assertNoResponseScope: args.assertNoResponseScope,
    });
    const contextInput = {
      thread,
      turns: allTurns,
      blocks: allBlocks,
      agentRevisions: deps.agentRevisions,
      threads: deps.repos.threads,
      toolRegistry: deps.toolRegistry,
      baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
      promptBakes: deps.repos.promptBakes,
      workContext: deps.workContext,
    };
    const agentContext = await resolveAgentThreadTurnContext(contextInput);
    const composition = await composeLivePromptBake(contextInput, agentContext);
    const provisionalBakeId = crypto.randomUUID();
    const blockInput = {
      turnId: placeholder.id,
      blockType: "custom" as const,
      sequence: 0,
      status: "complete" as const,
    };
    const props = {
      model: outcome.model,
      excludedTurnCount: projection.turns.filter(
        (turn) =>
          turn.role !== "compaction" &&
          allTurns.some((raw) => raw.id === turn.id) &&
          !decision.plan.retainedSuffix.some((slice) => slice.turn.id === turn.id),
      ).length,
      tokensBefore: decision.tokensBefore,
    };
    // The request this compaction would hand the successor, including its final summary text.
    const stage = (reshown: ReshownDocuments) => {
      const summary = [parsed.summary, documentsSection(reshown.labels)]
        .filter(Boolean)
        .join("\n\n");
      // Projection reads only the summary text; its provisional block is not persisted.
      const projectedSummary = localBlockFromEvent(
        contentForBlockInput({
          ...blockInput,
          content: { kind: "compaction", props: { ...props, summary, tokensAfter: 0 } },
        }),
      );
      const elisions = planModelElisions({
        retainedSuffix: decision.plan.retainedSuffix,
        recorded,
        current,
        reshown: reshown.fullyReshownDocumentIds,
        policies,
      });
      const metadata = { ...(placeholder.metadata as JsonObject), elisions };
      const provisional = {
        ...placeholder,
        status: "complete" as const,
        promptBakeId: provisionalBakeId,
        metadata: promptEpochMetadata(metadata),
      };
      const assemble = (
        lateTurns: Turn[],
        lateBlocks: Block[],
        selection?: import("./runtime-delivery.js").DeliveryBoundarySelection,
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
          blocks: [
            ...allBlocks,
            projectedSummary,
            ...reshown.blocks.map(localBlockFromEvent),
            ...lateBlocks,
          ],
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
          assertNoResponseScope: args.assertNoResponseScope,
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
      return { metadata, reshown, assemble, summary };
    };
    let staged = stage(NO_RESHOWN);
    const base = await staged.assemble([], []);
    const baseEstimate = fittingEstimate(base.assembled);
    let tokensAfter = baseEstimate.tokens;
    // The picker reserves the written list before admitting document text.
    const reshown = await reshowImportantFiles({
      ...args,
      policies,
      listedLines: parsed.listedLines,
      tokenizer: baseEstimate.tokenizer,
      budgetTokens: reshowBudgetTokens({
        triggerTokens: base.assembled.compactionTriggerTokens,
        baseTokens: tokensAfter,
      }),
    });
    if (reshown.blocks.length > 0) {
      staged = stage(reshown);
      // Measurement: the recorded `tokensAfter` is what the successor really carries.
      tokensAfter = fittingEstimate((await staged.assemble([], [])).assembled).tokens;
    }
    const summaryBlock = contentForBlockInput({
      ...blockInput,
      content: { kind: "compaction", props: { ...props, summary: staged.summary, tokensAfter } },
    });
    return {
      kind: "usable",
      metadata: staged.metadata,
      provisionalBakeId,
      composition,
      summaryBlock,
      reshown: staged.reshown,
      tokensAfter,
      model: outcome.model,
      decision,
      assemble: staged.assemble,
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { kind: "failed", failure: compactionFailureFrom(error, "initial_prepare") };
  }
}

export async function prepareCompactionContext(
  drain: InboxDrain,
  prepared: PreparedCompaction | undefined,
  selection: import("./runtime-delivery.js").DeliveryBoundarySelection,
) {
  if (!prepared) throw new Error("Missing prepared compaction");
  if (prepared.kind === "failed") throw new CompactionFailureError(prepared.failure);
  const next = await prepared.assemble(drain.turns, drain.blocks, selection);
  return {
    events: next.events,
    turns: next.turns,
    blocks: next.blocks,
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
}): Promise<{ turn: Turn; blocks: Block[] }> {
  const { deps, threadId, placeholder, prepared } = input;
  await input.settleResponses();
  const settled = await deps.repos.turns.findById(placeholder.id);
  if (!settled) throw new Error("Compaction placeholder disappeared");
  const deliveryFailure =
    input.failure === undefined ? undefined : compactionFailureFrom(input.failure, "delivery");
  const failure =
    prepared?.kind === "failed"
      ? prepared.failure
      : prepared?.kind === "usable" && deliveryFailure?.phase === "delivery"
        ? undefined
        : deliveryFailure;
  let blocks: Block[] = [];
  if (prepared?.kind === "usable" && failure === undefined) {
    const persisted = [prepared.summaryBlock, ...prepared.reshown.blocks];
    blocks = persisted.map(localBlockFromEvent);
    await beginPromptEpoch(deps, {
      threadId,
      boundaryTurnId: placeholder.id,
      bake: { compose: prepared.composition.bakeContent },
      completion: {
        blocks: persisted,
        compactionModel: prepared.model,
        metadata: { ...(settled.metadata as JsonObject), ...prepared.metadata },
        afterEvents: () =>
          recordReferenceEvidence(deps, threadId, placeholder.id, prepared.reshown.evidence),
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
    const outcome = failure ?? { reason: "compaction_failed" as const, phase: "delivery" as const };
    const failed = {
      ...settled,
      status: "error" as const,
      error: turnFailedCopy(settled),
      metadata: compactionFailureMetadata(settled.metadata, outcome),
      completedAt: new Date().toISOString(),
    };
    await persistAndAppendEvents(deps, threadId, async () => ({
      result: undefined,
      events: [
        {
          type: "turn.error",
          turn: failed,
          error: compactionFailureMeridianError(
            outcome,
            compactionFailureDiagnosticMessage(outcome.reason),
          ),
        },
      ],
    }));
  }
  const turn = await deps.repos.turns.findById(placeholder.id);
  if (!turn) throw new Error("Compaction placeholder disappeared");
  return { turn, blocks };
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
