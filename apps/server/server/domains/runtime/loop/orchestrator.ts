/**
 * Ordered model/tool loop. Preparation commits initial turns and report admission;
 * execution publishes through the journal, never a caller-driven event generator.
 * A RunSession owns the lease, cancellation, terminal fallback, and cleanup.
 *
 * - **blockSeq allocation**: content blocks (text, reasoning, tool_use) are
 *   numbered sequentially from the count of blocks already stored for the
 *   current turn. This is the persisted order the client reloads as the
 *   "linear" block display. The order of `result.content[]` comes from the
 *   adapter's index-sorted output (Anthropic's content-block index or OpenAI
 *   Responses' output_index — see the facts sheet and adapter docs).
 *   `blockSeq` is a turn-scoped monotonic counter, not a thread-global one.
 *
 * - **Tool_use-only blocks**: some adapters report tool calls only via
 *   `result.toolCalls[]` and not in `result.content[]`. When that happens,
 *   the orchestrator synthesizes a `tool_use` block so the persistence model
 *   always has a durable tool_use block to pair with the eventual tool_result.
 *
 * - **Local state accumulation**: to avoid re-reading the entire thread from
 *   the DB on every tool-loop iteration, the orchestrator maintains an
 *   in-memory `allTurns[]` + `allBlocks[]` accumulator that grows across
 *   iterations and assistant segments during a single run.
 *
 * - **MAX_TURN_ITERATIONS (32)**: a safety valve to prevent infinite
 *   tool-calling loops. After 32 iterations the turn is finalized with an error.
 *
 * Categories of OrchestratorEvent emitted:
 *
 *   | Event type              | When emitted                                |
 *   |-------------------------|---------------------------------------------|
 *   | turn.created            | Start of a user or assistant turn           |
 *   | block.upserted          | A content or tool_result block is persisted |
 *   | stream.delta            | Live streaming text/reasoning/tool_call     |
 *   | tool.executing          | Tool dispatch begins                        |
 *   | tool.output_delta       | Best-effort live stdout/stderr chunk        |
 *   | tool.result             | Tool execution completes                    |
 *   | permission.denied       | Tool blocked by PermissionGate              |
 *   | model.response_received | A model response is recorded                |
 *   | usage                   | Cumulative token/cost tick                  |
 *   | turn.completed          | Turn finishes successfully                  |
 *   | turn.cancelled          | Turn aborted via AbortSignal                |
 *   | turn.error              | Turn failed with an error                   |
 *
 * Depends on: gateway, tool executor, thread repositories, event journal.
 */

import {
  applyConcurrentRenderBudget,
  type ConcurrentEditInfo,
  isAgentEditResultEnvelope,
  modelConcurrentResult,
  modelResult,
  type ResponseCommitWriteReceipt,
} from "@meridian/agent-edit/integration";
import {
  type MeridianError,
  meridianErrorFromGateway,
  meridianErrorFromSystem,
} from "@meridian/contracts/interrupt";
import type { ProjectPreferences } from "@meridian/contracts/preferences";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget, type TreeBudget } from "@meridian/contracts/spawn";
import type {
  Block,
  ModelResponseReceivedRow,
  OrchestratorEvent,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { BillingUsagePolicy } from "../../billing/index.js";
import type { DocumentRevisions } from "../../context/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { AccountSkillInstallStore, AgentRevisionStore } from "../../packages/index.js";
import { isCacheReset } from "../../threads/domain/cache-reset.js";
import type {
  ActiveDocumentResolver,
  BlockRepository,
  EventJournalWriter,
  ModelResponseRepository,
  ThreadRepositories,
  ThreadRepository,
  TurnRepository,
} from "../../threads/index.js";
import {
  agentRequestMetadata,
  loadThreadConversationContext,
  readThreadActivity,
  ThreadConversationContextError,
  writerSendMetadata,
} from "../../threads/index.js";
import { nextTurnPosition } from "../../threads/order-turns.js";
import type { GenerateRequest, GenerateResult, Gateway as LlmGateway } from "../gateway/index.js";
import type { ModelRequestDebugStore } from "../model-request-debug/index.js";
import type { ConversationSummarizer } from "../ports/conversation-summarizer.js";
import { type ImageAssetPort, ImageAssetResolutionError } from "../ports/image-asset.js";
import { appendSubagentActivityForToolChangeBestEffort } from "../spawn/activity-event.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import { resolveMaxSpawnDepth } from "../spawn/tree-budget.js";
import type { ToolExecutor, ToolRegistry } from "../tools/index.js";
import {
  type ActivatedSkillBody,
  activatedSkillMetadata,
  formatInvokedSkills,
  isSkillBodyTurn,
  readActivatedSkillSlugs,
  SKILL_BODY_METADATA,
} from "./activated-skills.js";
import { loadUserSkillBody } from "./available-skills.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import {
  type CompactionDecision,
  CompactionPreparationError,
  type ForcedCompactionDecision,
} from "./compaction/decision.js";
import { FLOW_ABSOLUTE_CEILING } from "./compaction/index.js";
import { executeCompaction } from "./compaction-phase.js";
import { failCompactionSuccessor } from "./compaction-successor.js";
import { persistPreparedControlEvents } from "./compaction-undo.js";
import { absorbPendingCompact } from "./control-barrier.js";
import type { TerminalCause } from "./execution-finalizer.js";
import { type drainInbox, planMessageTurns } from "./inbox-context.js";
import { createInterruptSession, type InterruptArtifactFlushPort } from "./interrupt-session.js";
import {
  defaultInterruptAutoResumePolicy,
  type InterruptAutoResumePolicy,
  type InterruptRegistry,
} from "./interrupts.js";
import { createLocalTurn, currentTurnKind, reservationTurn } from "./local-turn.js";
import { modelResponseTimingFields } from "./model-response-timing.js";
import {
  hasPartialToolActivityTarget,
  parsePartialToolActivityInput,
  showsPartialToolActivityBeforeTarget,
} from "./partial-tool-activity.js";
import { type PermissionGate, permissionGateFromToolPolicy } from "./permissions/index.js";
import {
  appendEvent,
  persistAndAppendEvents,
  persistAndAppendTurnStartEvents,
} from "./persistence.js";
import type { RunClaim, ThreadPhase } from "./ports.js";
import { createPrefixCacheStateService, type PrefixCacheState } from "./prefix-cache-state.js";
import { writerFacingPreparationError } from "./preparation-failure.js";
import { loadReferenceReads, type ReferenceReader } from "./reference-context.js";
import {
  type PreparedControlHistory,
  prepareFailedUndoHistory,
  prepareRequestContext,
  UndoRequestPreparationError,
} from "./request-preparation.js";
import { createRunSessions } from "./run-session.js";
import {
  type DrainRunLoopInput,
  isDrainRun,
  NoPendingWakeError,
  type PreparedLoop,
  type RunLoopInput,
} from "./run-turn-port.js";
import type { AdoptedBatch, DeliveryBoundary, RuntimeDelivery } from "./runtime-delivery.js";
import { settleSummaryResponses } from "./settle-summary-responses.js";
import {
  collectToolCalls,
  contentPartToBlockInput,
  mapStreamEvent,
  toJsonValue,
} from "./streaming.js";
import { dispatchToolCall } from "./tool-dispatch.js";
import { createTurnAccounting, type TurnAccounting } from "./turn-accounting.js";
import {
  type AssembledNextTurnContext,
  persistPreparedPromptBake,
} from "./turn-context-assembly.js";
import type { WorkContextReader } from "./work-context.js";
import { persistWriterTurn } from "./writer-enqueue.js";

const MAX_TURN_ITERATIONS = 32;

class RequestPreparationError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "RequestPreparationError";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error });
}

export interface OrchestratorRepositories {
  threads: ThreadRepository;
  turns: TurnRepository;
  promptBakes: ThreadRepositories["promptBakes"];
  imageInclusions: ThreadRepositories["imageInclusions"];
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
  executionReports: ThreadRepositories["executionReports"];
  readSnapshot: ThreadRepositories["readSnapshot"];
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  runTurnStartTransition<T>(
    threadId: ThreadId,
    expectedActiveLeafTurnId: TurnId | null,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface OrchestratorDeps {
  summarizer: ConversationSummarizer;
  gateway: LlmGateway;
  toolExecutor: ToolExecutor;
  referenceReader: ReferenceReader;
  documentRevisions: DocumentRevisions;
  repos: OrchestratorRepositories;
  eventWriter: EventJournalWriter;
  headSeq(threadId: ThreadId): Promise<bigint>;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readThreadBinding" | "listInstallations" | "readSource" | "readRevision"
  >;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
  toolRegistry: ToolRegistry;
  projectPreferences: {
    read(userId: string, projectId: string): Promise<ProjectPreferences>;
  };
  workWriteMode: {
    read(workId: string): Promise<AiWriteMode>;
  };
  workContext: WorkContextReader;
  billingUsage: BillingUsagePolicy;
  /** Interrupt-boundary artifact flush; explicit noop adapter means disabled. */
  interruptArtifacts: InterruptArtifactFlushPort;
  childRunCoordinator: ChildRunCoordinator;
  interruptRegistry: InterruptRegistry;
  eventSink: EventSink;
  modelRequestDebug: ModelRequestDebugStore;
  /** Durable per-thread message queue drained into each model request. */
  delivery: RuntimeDelivery;
  /** Session claim and observable lease lifetime. */
  runClaim: RunClaim;
  activeDocuments: ActiveDocumentResolver;
  imageAssets: ImageAssetPort;
  /** Aggregate concurrent-edit rendering allowance derived from the selected registry model. */
  concurrentRenderBudgetBytes?(request: GenerateRequest): number;
  responseWrites: {
    commitResponse(
      responseId: string,
      ctx: { threadId: ThreadId; turnId: TurnId },
      beforeTransactionCommit: (result: ResponseWriteCommitOutcome) => Promise<void>,
    ): Promise<ResponseWriteCommitOutcome>;
    rollbackResponse(
      responseId: string,
      ctx: { threadId: ThreadId; turnId: TurnId },
    ): Promise<void>;
  };
}

type ResponseWriteCommitOutcome =
  | {
      status: "committed";
      receipts: Array<{ documentId: string; receipt: ResponseCommitWriteReceipt }>;
      concurrentEdits: { documentId: string; concurrentEdits: ConcurrentEditInfo }[];
    }
  | { status: "draft_closed"; responseId: string; mode: "draft" };

function settledReceipt(
  receipts: Extract<ResponseWriteCommitOutcome, { status: "committed" }>["receipts"],
  documentId: string,
  settlementId: string,
): ResponseCommitWriteReceipt {
  const settled = receipts.find(
    (entry) => entry.documentId === documentId && entry.receipt.settlementId === settlementId,
  );
  if (!settled) {
    throw new Error(`Settled receipt missing for ${documentId}:${settlementId}.`);
  }
  return settled.receipt;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  return createRunSessions({
    ...deps,
    setup: (input) => prepareLoop(deps, input),
    async finalizeFailure(input) {
      const error =
        input.error instanceof RequestPreparationError ? input.error.original : input.error;
      const contextError = error instanceof ThreadConversationContextError ? error : null;
      const imageResolutionError = error instanceof ImageAssetResolutionError ? error : null;
      const preparationFailure =
        contextError ??
        imageResolutionError ??
        (error instanceof CompactionPreparationError ? error : null);
      const requestPreparationFailed = input.error instanceof RequestPreparationError;
      const outcome = await deps.delivery.close({
        lease: input.lease,
        turnId: input.turnId,
        cause: input.signal?.aborted
          ? { kind: "cancelled", reason: "cancelled" }
          : {
              kind: "failed",
              reason:
                (error instanceof CompactionPreparationError ? error.reason : contextError?.code) ??
                (imageResolutionError
                  ? "image_resolution_failed"
                  : requestPreparationFailed
                    ? "request_preparation_failed"
                    : "execution_error"),
              ...(preparationFailure || requestPreparationFailed ? { acknowledgeInbox: true } : {}),
              error: preparationFailure
                ? writerFacingPreparationError(preparationFailure)
                : requestPreparationFailed
                  ? writerFacingPreparationError(asError(error))
                  : error instanceof Error
                    ? error.message
                    : String(error),
            },
      });
      if (outcome.kind !== "completed") throw new Error("Failure finalization cannot split");
      return outcome.completion.turn;
    },
  });
}

// USD rollups are display-side estimates only; the authoritative ledger truth
// is integer millicredits. Keep these strings stable for UI snapshots, but do
// not use them for billing decisions.
function addCostUsd(a: string, b: string): string {
  return (Number(a) + Number(b)).toFixed(6);
}

function addOptionalInteger(current: number | null | undefined, delta: number | null | undefined) {
  return delta != null ? (current ?? 0) + delta : current;
}

function addMillicredits(
  current: string | null | undefined,
  delta: string | null | undefined,
): string | undefined {
  if (delta == null) return current ?? undefined;
  return (BigInt(current ?? "0") + BigInt(delta)).toString();
}

function applyResponseToTurnSnapshot(turn: Turn, response: ModelResponseReceivedRow): Turn {
  const inputTokens = turn.inputTokens + (response.inputTokens ?? 0);
  const outputTokens = turn.outputTokens + (response.outputTokens ?? 0);
  const reasoningTokens = addOptionalInteger(turn.reasoningTokens, response.reasoningTokens);
  const cacheReadTokens = addOptionalInteger(turn.cacheReadTokens, response.cacheReadTokens);
  const cacheWriteTokens = addOptionalInteger(turn.cacheWriteTokens, response.cacheWriteTokens);
  const totalCostUsd = addCostUsd(turn.totalCostUsd, response.costUsd ?? "0");
  const totalMillicredits = addMillicredits(turn.totalMillicredits, response.millicredits ?? null);
  const responseCount = turn.responseCount + 1;
  return {
    ...turn,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalCostUsd,
    totalMillicredits,
    responseCount,
    model: response.model ?? turn.model,
    provider: response.provider ?? turn.provider,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalCostUsd,
      totalMillicredits,
      responseCount,
    },
  };
}

async function resolveInterruptAutoResumePolicy(
  deps: OrchestratorDeps,
  thread: Thread,
): Promise<InterruptAutoResumePolicy> {
  const preferences = await deps.projectPreferences.read(thread.userId, thread.projectId);
  return preferences.autoResume ?? defaultInterruptAutoResumePolicy();
}

async function admitRunExecution(
  deps: OrchestratorDeps,
  input: RunLoopInput,
  thread: Thread,
  executionTurnId: TurnId,
): Promise<void> {
  if (thread.kind !== "subagent" && input.executionReport) {
    throw new Error("Execution report correlation requires a subagent thread");
  }
  if (thread.kind === "subagent") {
    if (!thread.ref) throw new Error("Subagent thread has no project handle");
    const correlation = input.executionReport?.correlation ?? {
      callerThreadId: null,
      callerTurnId: null,
      toolCallId: null,
      cardBlockId: null,
      origin: "thread_run" as const,
      deliveryMode: "none" as const,
    };
    await deps.repos.executionReports.admit({
      childThreadId: input.threadId,
      executionTurnId,
      handle: thread.ref,
      ...correlation,
      agentSlug: input.executionReport?.agentSlug ?? null,
      description: input.executionReport?.description ?? null,
    });
  }
}

/** Commit initial history before handing the session its lazy model loop. */
async function prepareLoop(deps: OrchestratorDeps, input: RunLoopInput): Promise<PreparedLoop> {
  const { repos } = deps;
  const thread = await repos.threads.findById(input.threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${input.threadId}`);
  }

  // New turns require positive balance; the mid-stream gate in turn-accounting
  // allows zero grace only after an already-started turn is in flight.
  if (!(await deps.billingUsage.canStartTurn(thread.userId))) {
    throw meridianErrorFromSystem(
      "credits_exhausted",
      "Your usage balance is exhausted; add balance before starting a new turn",
    );
  }

  if (isDrainRun(input)) {
    return runDrainTurn(deps, input);
  }
  const userTurnId = crypto.randomUUID() as TurnId;
  const userMetadata = input.userTurnMetadata;
  const skillMetadata = activatedSkillMetadata(input.activatedSkillSlugs ?? []);
  const metadata = writerSendMetadata({
    ...(userMetadata && typeof userMetadata === "object" && !Array.isArray(userMetadata)
      ? userMetadata
      : {}),
    ...(skillMetadata && typeof skillMetadata === "object" && !Array.isArray(skillMetadata)
      ? skillMetadata
      : {}),
    ...(input.child ? agentRequestMetadata(input.child.origin) : {}),
  });
  let reservedTurnId: TurnId | undefined;
  const userTurn = await deps.delivery.withThreadLock(input.threadId, async (producer) => {
    const thread = await deps.repos.threads.findById(input.threadId);
    if (!thread) throw new Error(`Thread not found: ${input.threadId}`);
    return persistWriterTurn({
      persistence: deps,
      threadId: input.threadId,
      userTurnId,
      userBlocks: input.userBlocks ?? [{ type: "text", text: input.userText }],
      userTurnMetadata: metadata,
      origin: input.child ? "system" : "writer",
      producer,
      afterTurnCreated: () => {
        reservedTurnId = crypto.randomUUID() as TurnId;
      },
      draft: {
        id: userTurnId,
        threadId: input.threadId,
        intent: "message",
        provenance: input.child
          ? { kind: "agent", threadId: input.threadId }
          : { kind: "writer", actorId: thread.userId },
        body: { kind: "text", text: input.userText },
        idempotencyKey: userTurnId,
      },
    });
  });
  try {
    if (!reservedTurnId) throw new Error("Direct writer turn did not allocate its reservation ID");
    return await runDrainTurn(deps, { ...input, drain: true }, reservedTurnId);
  } catch (error) {
    if (input.signal?.aborted) {
      await deps.delivery.withThreadLock(input.threadId, (producer) =>
        producer.acknowledge([userTurn.id]),
      );
    }
    throw error;
  }
}

/**
 * Drain-only start: a wake begins with no new writer turn. In one transition it
 * claims the pending inbox batch, persists each fresh message as a user-role turn
 * chained from the thread leaf, then mints the assistant container chained from
 * the last message. The durable chain is `leaf → message(user) → assistant(streaming)`
 * and the first request is built over exactly the drained batch. A redelivered
 * message already persisted by a crashed run is not re-appended; its existing turn
 * rides in `priorTurns`. No durable pending message means no turn to generate.
 */
async function runDrainTurn(
  deps: OrchestratorDeps,
  input: DrainRunLoopInput,
  reservedTurnId: TurnId = crypto.randomUUID(),
): Promise<PreparedLoop> {
  let preparationError: Error | null = null;
  const setup = await deps.delivery.adoptBatch(
    input.lease,
    async (selection) => {
      const setupThread = await deps.repos.threads.findById(input.threadId);
      if (!setupThread) throw new Error(`Thread not found: ${input.threadId}`);
      const batch = selection.batch;
      const ctx = await loadRunStartContext(deps, setupThread);
      preparationError = ctx.contextError;
      const { priorTurns, inheritedTurns, inheritedBlocks, prevTurnId } = ctx;
      const existingTurns = [...inheritedTurns, ...priorTurns];
      const previousTurn = prevTurnId
        ? (existingTurns.find((turn) => turn.id === prevTurnId) ?? null)
        : null;
      if (prevTurnId && !previousTurn) throw new Error(`Missing causal turn: ${prevTurnId}`);
      if (!selection.control && !batch.some((message) => message.intent === "message")) {
        throw new NoPendingWakeError(input.threadId);
      }
      const turnById = new Map(
        [...inheritedTurns, ...priorTurns].map((turn) => [turn.id as string, turn]),
      );
      const knownTurnIds = new Set([
        ...inheritedTurns.map((turn) => turn.id as TurnId),
        ...priorTurns.map((turn) => turn.id as TurnId),
      ]);
      let skillBody: Awaited<ReturnType<typeof createSkillBodyTurn>> = null;
      const makePlan = (notices: typeof selection.notices) =>
        planMessageTurns({
          threadId: input.threadId,
          batch,
          prevTurnId: skillBody?.turn.id ?? prevTurnId,
          prevTurnPosition: skillBody?.turn.position ?? previousTurn?.position ?? null,
          knownTurnIds,
          workContext: selection.workContext,
          notices,
        });
      if (!preparationError) {
        try {
          const activatedSkillSlugs = [
            ...new Set(
              batch.flatMap((message) => {
                const turn = turnById.get(message.id);
                return turn ? readActivatedSkillSlugs(turn) : [];
              }),
            ),
          ];
          skillBody = await createSkillBodyTurn({
            deps,
            thread: setupThread,
            threadId: input.threadId,
            invokingTurnId: prevTurnId,
            invokingTurnPosition: previousTurn?.position ?? null,
            slugs: activatedSkillSlugs,
          });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          preparationError = asError(error);
        }
      }
      let plan = makePlan(preparationError ? [] : selection.notices);
      const referenceUserTurnId =
        [...plan.turns].reverse().find((turn) => turn.role === "user")?.id ??
        [...priorTurns, ...inheritedTurns].reverse().find((turn) => turn.role === "user")?.id ??
        prevTurnId ??
        reservedTurnId;
      let preflight: Awaited<ReturnType<typeof prepareRequestContext>> | null = null;
      let failedControls: PreparedControlHistory | null = null;
      if (!preparationError) {
        try {
          const previousBlocks = await deps.repos.blocks.listByThread(input.threadId);
          preflight = await prepareRequestContext({
            deps,
            thread: setupThread,
            threadId: input.threadId,
            referenceTurnId: referenceUserTurnId,
            currentTurnId: reservedTurnId,
            controls: selection.controls,
            followingBatches: selection.followingBatches,
            failedUndoIds: selection.failedUndoIds,
            continueAfterControls: selection.outstanding.length > 0,
            pinnedRequestTurnIds: new Set(selection.outstanding.map((row) => row.id)),
            turns: [
              ...inheritedTurns,
              ...priorTurns,
              ...(skillBody ? [skillBody.turn] : []),
              ...plan.turns,
            ],
            blocks: [
              ...inheritedBlocks,
              ...previousBlocks,
              ...plan.blocks.map(localBlockFromEvent),
              ...(skillBody ? [localBlockFromEvent(skillBody.block)] : []),
            ],
            baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
            signal: input.signal,
          });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          preparationError = asError(error);
        }
      }
      if (preparationError) {
        preflight = null;
        skillBody = null;
        plan = makePlan([]);
        if (preparationError instanceof UndoRequestPreparationError) {
          failedControls = preparationError.after(plan.turns.at(-1) ?? previousTurn);
        } else if (selection.controls?.some((c) => c.body.kind === "compaction_undo")) {
          failedControls = await prepareFailedUndoHistory({
            deps,
            thread: setupThread,
            threadId: input.threadId,
            referenceTurnId: referenceUserTurnId,
            currentTurnId: reservedTurnId,
            turns: [...inheritedTurns, ...priorTurns, ...plan.turns],
            blocks: [],
            controls: selection.controls,
            followingBatches: selection.followingBatches,
            signal: input.signal,
          });
        }
      }
      const controlPreparation = preflight ?? failedControls;
      if (preflight)
        preflight.compaction = absorbPendingCompact(preflight.compaction, selection.headControl);
      const controlId =
        preflight?.compaction.kind === "compact"
          ? (preflight.compaction.controlMessageId ?? preflight.compaction.satisfiesControlId)
          : undefined;
      const imageUpdateTurn = controlPreparation?.turns.at(-1);
      const terminal =
        !!controlPreparation?.undos.length &&
        selection.outstanding.length === 0 &&
        preflight?.compaction.kind !== "compact";
      const reservedTurn = terminal
        ? controlPreparation!.undos.at(-1)!.turn
        : reservationTurn(
            {
              id: reservedTurnId,
              threadId: input.threadId,
              prevTurnId:
                imageUpdateTurn?.id ?? plan.leafTurnId ?? skillBody?.turn.id ?? prevTurnId,
              position: nextTurnPosition(
                imageUpdateTurn ?? plan.turns.at(-1) ?? skillBody?.turn ?? previousTurn,
              ),
            },
            preflight?.compaction,
          );
      if (preparationError && selection.control?.body.kind === "compact") {
        reservedTurn.role = "compaction";
        reservedTurn.origin = "system";
        reservedTurn.status = "pending";
        reservedTurn.metadata = { trigger: "manual", controlMessageId: selection.control.id };
      }
      const value = {
        reservedTurn,
        terminal,
        skillBody,
        referenceUserTurnId,
        preflight,
        messageTurns: plan.turns,
        priorTurns,
        inheritedTurns,
        inheritedBlocks,
        executionAdmitted: selection.outstanding.length > 0,
      };
      const events = [
        ...(skillBody
          ? [
              { type: "turn.created" as const, turn: skillBody.turn },
              { type: "block.upserted" as const, block: skillBody.block },
            ]
          : []),
        ...plan.events,
        ...(controlPreparation?.events ?? []),
        ...(!terminal ? [{ type: "turn.created" as const, turn: reservedTurn }] : []),
      ];
      return {
        value,
        turnId: reservedTurn.id,
        terminal,
        completedControlIds: controlPreparation?.undos.map((u) => u.controlId),
        turnKind: terminal ? ("assistant" as const) : currentTurnKind(reservedTurn),
        messageIds: [
          ...batch.map(({ id }) => id),
          ...(controlPreparation?.adoptedIds ?? []),
          ...(controlId
            ? [controlId]
            : preparationError && selection.control?.body.kind === "compact"
              ? [selection.control.id]
              : []),
        ],
        ...(preparationError === null ? {} : { preparationFailure: preparationError }),
        persist: async () => {
          await persistAndAppendTurnStartEvents(
            deps,
            input.threadId,
            selection.activeLeafTurnId,
            async () => {
              await reconcileOrphanedPendingWrites(deps, input.threadId);
              if (preflight)
                await persistPreparedPromptBake(
                  preflight.assembled,
                  deps.repos.threads.bakeInitialPrompt.bind(deps.repos.threads),
                );
              reservedTurn.writeMode = setupThread.workId
                ? await deps.workWriteMode.read(setupThread.workId)
                : "direct";
              return {
                result: undefined,
                events: await persistPreparedControlEvents(
                  deps,
                  input.threadId,
                  events,
                  controlPreparation?.undos ?? [],
                ),
              };
            },
            {
              afterEvents: async () => {
                if (selection.outstanding.length > 0)
                  await admitRunExecution(deps, input, setupThread, reservedTurn.id);
              },
            },
          );
        },
      };
    },
    { signal: input.signal },
  );

  const {
    reservedTurn,
    skillBody,
    referenceUserTurnId,
    preflight,
    messageTurns,
    priorTurns,
    inheritedTurns,
    inheritedBlocks,
  } = setup;
  return {
    userTurnId: referenceUserTurnId,
    terminalTurnId: setup.terminal ? reservedTurn.id : undefined,
    currentTurn: setup.terminal
      ? null
      : {
          id: reservedTurn.id,
          kind: currentTurnKind(reservedTurn),
        },
    execute: async () => {
      if (setup.terminal) return reservedTurn;
      if (preparationError) throw new RequestPreparationError(preparationError);
      if (!preflight) throw new Error("Request context is unavailable after preparation failed");
      return executeLoop(
        deps,
        input,
        preflight.assembled.thread,
        reservedTurn,
        [
          ...inheritedTurns,
          ...priorTurns,
          ...(skillBody ? [skillBody.turn] : []),
          ...messageTurns,
          ...preflight.turns,
        ],
        inheritedBlocks,
        preflight.assembled,
        preflight.compaction,
        setup.executionAdmitted,
        input.treeBudget ??
          createDefaultTreeBudget({ maxDepth: resolveMaxSpawnDepth(process.env) }),
      );
    },
  };
}

/**
 * The shared run-start prelude: reconcile interrupted staged writes, load the
 * thread's prior turns and inherited (fork) conversation, and resolve the turn
 * to chain from. Both writer and drain starts run this inside their run-start
 * transition; they differ only in the user-turn source they mint afterward.
 */
async function loadRunStartContext(
  deps: OrchestratorDeps,
  thread: Thread,
): Promise<{
  priorTurns: Turn[];
  inheritedTurns: Turn[];
  inheritedBlocks: Block[];
  prevTurnId: TurnId | null;
  contextError: ThreadConversationContextError | null;
}> {
  const { repos } = deps;
  const priorTurns = await repos.turns.listByThread(thread.id);
  let conversation: Awaited<ReturnType<typeof loadThreadConversationContext>>;
  try {
    conversation = await loadThreadConversationContext(
      { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
      thread,
    );
  } catch (error) {
    if (!(error instanceof ThreadConversationContextError)) throw error;
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.orchestrator",
      name: "thread.conversation_context.load_failed",
      correlation: { threadId: error.threadId },
      payload: {
        threadId: error.threadId,
        cutoffTurnId: error.originTurnId,
        errorCode: error.code,
      },
    });
    return {
      priorTurns,
      inheritedTurns: [],
      inheritedBlocks: [],
      prevTurnId: thread.activeLeafTurnId ?? priorTurns.at(-1)?.id ?? null,
      contextError: error,
    };
  }
  const inheritedTurnCount = Math.max(0, conversation.turns.length - priorTurns.length);
  const inheritedTurns = conversation.turns.slice(0, inheritedTurnCount);
  const inheritedTurnIds = new Set(inheritedTurns.map((turn) => turn.id));
  const inheritedBlocks = conversation.blocks.filter((block) => inheritedTurnIds.has(block.turnId));
  const sortedLeaf = priorTurns.at(-1) ?? inheritedTurns.at(-1) ?? null;
  // The durable leaf owns causal chaining; position owns transcript ordering.
  const prevTurnId = thread.activeLeafTurnId ?? sortedLeaf?.id ?? null;
  return { priorTurns, inheritedTurns, inheritedBlocks, prevTurnId, contextError: null };
}

async function reconcileOrphanedPendingWrites(
  deps: OrchestratorDeps,
  threadId: ThreadId,
): Promise<void> {
  const blocks = await deps.repos.blocks.listByThread(threadId);
  for (const block of blocks) {
    if (block.blockType !== "tool_result") continue;
    const content = block.content as {
      output?: unknown;
      metadata?: { stagedWrite?: unknown };
    } | null;
    if (content?.metadata?.stagedWrite !== true || !isAgentEditResultEnvelope(content.output)) {
      continue;
    }
    if (content.output.phase !== "staged") continue;
    await persistUncommittedWriteResult({
      deps,
      threadId,
      block,
      text: "The response ended before its staged write could commit. Re-read and retry.",
    });
  }
}

async function persistModelResponse(input: {
  deps: OrchestratorDeps;
  runInput: RunLoopInput;
  thread: Thread;
  currentTurn: Turn;
  result: GenerateResult;
  requestMessageCount: number;
  predictedCacheState: PrefixCacheState;
  treeBudget: TreeBudget;
  turnAccounting: TurnAccounting;
  blockSeq: number;
  /** Ids of the inbox batch this response carries; acked in the persist transaction. */
  inboxAckIds: string[];
}): Promise<{
  responseId: string;
  updatedTurn: Turn;
  createdBlocks: Block[];
  toolCalls: ReturnType<typeof collectToolCalls>;
  nextBlockSeq: number;
}> {
  const { deps, runInput, thread, currentTurn, result, treeBudget, turnAccounting } = input;
  let blockSeq = input.blockSeq;
  const responseSeq = currentTurn.responseCount;
  const toolCalls = collectToolCalls(result);
  const persistedResponse = await deps.delivery.ackWithResponse(
    runInput.lease,
    input.inboxAckIds,
    () =>
      persistAndAppendEvents(deps, runInput.threadId, async () => {
        const responseId = crypto.randomUUID();
        const computedCost = await turnAccounting.computeAndDebit(
          result,
          thread,
          runInput.threadId,
          currentTurn.id,
          treeBudget,
          responseId,
        );
        const costUsd = computedCost.costUsd;
        const cacheResetContext = await deps.repos.modelResponses.cacheResetContext(
          runInput.threadId,
        );
        const response: ModelResponseReceivedRow = {
          id: responseId,
          turnId: currentTurn.id,
          sequence: responseSeq,
          provider: result.provider,
          model: result.model,
          providerRequestId: result.providerRequestId ?? null,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: result.usage.reasoningTokens ?? null,
          cacheReadTokens: result.usage.cacheReadTokens ?? null,
          cacheWriteTokens: result.usage.cacheWriteTokens ?? null,
          cacheReset: isCacheReset({
            ...cacheResetContext,
            currentCacheReadTokens: result.usage.cacheReadTokens ?? null,
          }),
          costUsd,
          millicredits: computedCost.millicredits,
          priceSource: computedCost.priceSource,
          pricingSnapshot: computedCost.pricingSnapshot,
          finishReason: result.finishReason,
          ...modelResponseTimingFields(result),
          rawUsage: toJsonValue(result.usage),
          requestMessageCount: input.requestMessageCount,
          predictedCacheState: input.predictedCacheState.state,
          predictedCacheReason: input.predictedCacheState.reason,
        };
        const updatedTurn = applyResponseToTurnSnapshot(currentTurn, response);

        const createdBlocks: Block[] = [];
        const events: OrchestratorEvent[] = [{ type: "model.response_received", response }];
        for (const part of result.content) {
          const blockInput = contentPartToBlockInput(
            part,
            updatedTurn.id,
            blockSeq++,
            response.id,
            result.provider,
          );
          if (blockInput) {
            const block = contentForBlockInput(blockInput);
            createdBlocks.push(localBlockFromEvent(block));
            events.push({ type: "block.upserted", block });
          }
        }

        for (const call of toolCalls) {
          if (result.content.some((p) => p.type === "tool_use" && p.toolCallId === call.id)) {
            continue;
          }
          const block = contentForBlockInput({
            turnId: updatedTurn.id,
            blockType: "tool_use",
            sequence: blockSeq++,
            responseId: response.id,
            content: {
              toolCallId: call.id,
              toolName: call.name,
              input: toJsonValue(call.arguments),
            },
            provider: result.provider,
            status: "complete",
          });
          createdBlocks.push(localBlockFromEvent(block));
          events.push({ type: "block.upserted", block });
        }

        events.push({
          type: "usage",
          responseId: response.id,
          turnId: updatedTurn.id as string,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: result.usage.reasoningTokens ?? null,
          cacheReadTokens: result.usage.cacheReadTokens ?? null,
          cacheWriteTokens: result.usage.cacheWriteTokens ?? null,
          costUsd,
          turnCostUsd: updatedTurn.totalCostUsd,
          model: result.model,
          provider: result.provider,
        });

        return {
          result: { responseId, updatedTurn, createdBlocks },
          events,
        };
      }),
  );

  return {
    responseId: persistedResponse.result.responseId,
    updatedTurn: persistedResponse.result.updatedTurn,
    createdBlocks: persistedResponse.result.createdBlocks,
    toolCalls,
    nextBlockSeq: blockSeq,
  };
}

/**
 * Persists partial usage before the terminal cancellation transaction. That
 * transaction retires the adopted lease receipt; unadopted follow-ups remain
 * pending for a later run.
 */
async function settleCancelledResponse(input: {
  deps: OrchestratorDeps;
  runInput: RunLoopInput;
  thread: Thread;
  currentTurn: Turn;
  treeBudget: TreeBudget;
  turnAccounting: TurnAccounting;
  blockSeq: number;
  allBlocks: Block[];
  result: GenerateResult | undefined;
  model: string;
  requestMessageCount: number;
  predictedCacheState: PrefixCacheState;
}): Promise<Turn> {
  const settlement = await input.deps.gateway.settleCancelledResult?.({
    model: input.model,
    ...(input.result ? { result: input.result } : {}),
    ...(input.result?.providerRequestId
      ? { providerRequestId: input.result.providerRequestId }
      : {}),
  });

  let currentTurn = input.currentTurn;
  if (settlement?.persist) {
    const persistedResponse = await persistModelResponse({
      deps: input.deps,
      runInput: input.runInput,
      thread: input.thread,
      currentTurn,
      result: settlement.result,
      requestMessageCount: input.requestMessageCount,
      predictedCacheState: input.predictedCacheState,
      treeBudget: input.treeBudget,
      turnAccounting: input.turnAccounting,
      blockSeq: input.blockSeq,
      // The terminal cancellation retires the lease receipt after settlement.
      inboxAckIds: [],
    });
    currentTurn = persistedResponse.updatedTurn;
    input.allBlocks.push(...persistedResponse.createdBlocks);
    await input.deps.responseWrites.rollbackResponse(persistedResponse.responseId, {
      threadId: input.runInput.threadId,
      turnId: currentTurn.id,
    });
  }
  return currentTurn;
}

async function persistToolRejection(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  turn: Turn;
  call: ReturnType<typeof collectToolCalls>[number];
  decision: {
    allowed: false;
    kind: "permission_denied" | "invalid_arguments";
    category: Extract<OrchestratorEvent, { type: "permission.denied" }>["category"];
    reason: string;
  };
  blockSeq: number;
}): Promise<{ block: Block; nextBlockSeq: number }> {
  let blockSeq = input.blockSeq;
  const rejectionOutput = {
    error: input.decision.kind,
    reason: input.decision.reason,
  };
  const persistedRejection = await persistAndAppendEvents(input.deps, input.threadId, async () => {
    const block = contentForBlockInput({
      turnId: input.turn.id,
      blockType: "tool_result",
      sequence: blockSeq++,
      content: {
        toolCallId: input.call.id,
        output: rejectionOutput,
        isError: true,
      },
      status: "complete",
    });
    return {
      result: localBlockFromEvent(block),
      events: [
        { type: "block.upserted", block },
        ...(input.decision.kind === "permission_denied"
          ? [
              {
                type: "permission.denied" as const,
                toolCallId: input.call.id,
                toolName: input.call.name,
                category: input.decision.category,
                reason: input.decision.reason,
              },
            ]
          : []),
        {
          type: "tool.result",
          toolCallId: input.call.id,
          output: rejectionOutput,
          isError: true,
        },
      ],
    };
  });
  return {
    block: persistedRejection.result,
    nextBlockSeq: blockSeq,
  };
}

async function persistUncommittedWriteResult(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  block: Block;
  text: string;
}): Promise<{ block: Block }> {
  const content = input.block.content as { toolCallId?: string } | null;
  const toolCallId = content?.toolCallId ?? "";
  const priorOutput = (input.block.content as { output?: unknown } | null)?.output;
  const message = ["Write did not land.", input.text].join("\n\n");
  const output = toJsonValue(
    modelResult({
      command: isAgentEditResultEnvelope(priorOutput) ? priorOutput.command : "unknown",
      status: "internal_error",
      payload: { message },
    }),
  );
  const persisted = await persistAndAppendEvents(input.deps, input.threadId, async () => {
    const block = contentForBlockInput({
      id: input.block.id,
      turnId: input.block.turnId,
      responseId: input.block.responseId,
      blockType: "tool_result",
      sequence: input.block.sequence,
      content: { toolCallId, output, isError: true },
      provider: input.block.provider,
      status: "complete",
    });
    return {
      result: localBlockFromEvent(block),
      events: [
        { type: "block.upserted", block },
        { type: "tool.result", toolCallId, output, isError: true },
      ],
    };
  });
  return { block: persisted.result };
}

async function persistCommittedWriteResult(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  block: Block;
  output: unknown;
  documentRevision: DocumentRevisionEvidence;
}): Promise<{ block: Block }> {
  const content = input.block.content as {
    toolCallId?: string;
    metadata?: Record<string, unknown>;
  } | null;
  const metadata = { ...content?.metadata };
  metadata.documentRevisions = [input.documentRevision];
  const toolCallId = content?.toolCallId ?? "";
  const persisted = await persistAndAppendEvents(input.deps, input.threadId, async () => {
    const block = contentForBlockInput({
      id: input.block.id,
      turnId: input.block.turnId,
      responseId: input.block.responseId,
      blockType: "tool_result",
      sequence: input.block.sequence,
      content: toJsonValue({ toolCallId, output: input.output, metadata }),
      provider: input.block.provider,
      status: "complete",
    });
    return {
      result: localBlockFromEvent(block),
      events: [
        { type: "block.upserted", block },
        { type: "tool.result", toolCallId, output: toJsonValue(input.output) },
      ],
    };
  });
  return { block: persisted.result };
}

/**
 * Loads text-reference reads for one user turn, returning prepared events and
 * blocks with read results applied. Used both
 * at iteration 1 (the run's triggering turn) and when a mid-run drain adopts a
 * writer turn whose references were never read.
 */
async function prepareReferenceReads(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  userTurnId: string;
  assistantTurnId: string;
  blocks: readonly Block[];
  signal?: AbortSignal;
}): Promise<{ blocks: Block[]; events: OrchestratorEvent[] }> {
  const loaded = await loadReferenceReads({
    blocks: input.blocks,
    userTurnId: input.userTurnId,
    threadId: input.threadId,
    assistantTurnId: input.assistantTurnId,
    reader: input.deps.referenceReader,
    signal: input.signal,
  });
  if (loaded.length === 0) return { blocks: [...input.blocks], events: [] };
  const events = loaded.map((block) => ({
    type: "block.upserted" as const,
    block: contentForBlockInput({
      id: block.id,
      turnId: block.turnId,
      responseId: block.responseId,
      blockType: block.blockType,
      sequence: block.sequence,
      content: block.content,
      status: "complete",
    }),
  }));
  const updatedById = new Map(loaded.map((block) => [block.id, block]));
  return {
    blocks: input.blocks.map((block) => updatedById.get(block.id) ?? block),
    events,
  };
}

/** Prepared body turns for one turn's activated skills. */
type SkillBodyPreparation =
  | { kind: "none" }
  | { kind: "existing"; turn: Turn }
  | { kind: "created"; turn: Turn; block: Block };

/**
 * Loads and prepares one hidden `system`-role turn carrying every activated
 * skill's body, chained immediately after the turn that invoked them. Never a
 * block on the invoking turn itself -- `UserTurn.tsx`'s `projectUserTurn` (and
 * chat previews, fork/handoff copies) concatenates every text block of a user
 * turn, so a body block placed there renders inside the writer's own bubble.
 * A separate `system`-role turn with `SKILL_BODY_METADATA` and no custom block
 * is already invisible everywhere `visible-conversation-policy.ts` and the
 * app's `visible-chat-turns.ts` hide a `system_update` turn, and is never
 * routed to `UserTurn` in the first place.
 *
 * Idempotent: `existingTurns` (the run's accumulated turn list, seeded from
 * durable history at run start) is searched for an already-persisted body
 * turn chained from `invokingTurnId` before preparing a new one, so a retried
 * drain (a crash between commit and ack) never double-persists. Persisting the
 * body once means a later request reproduces the exact bytes an earlier
 * request saw even if the skill's live content changes afterward -- unlike
 * the deleted request-only splice, which vanished on the very next request.
 */
async function prepareSkillBodies(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  invokingTurnId: TurnId;
  existingTurns: readonly Turn[];
  slugs: readonly string[];
  loadSkillBodies: (slugs: readonly string[]) => Promise<ActivatedSkillBody[]>;
}): Promise<SkillBodyPreparation> {
  if (input.slugs.length === 0) return { kind: "none" };
  const existing = input.existingTurns.find(
    (turn) => turn.prevTurnId === input.invokingTurnId && isSkillBodyTurn(turn),
  );
  if (existing) return { kind: "existing", turn: existing };
  const invokingTurn = input.existingTurns.find((turn) => turn.id === input.invokingTurnId);
  if (!invokingTurn) throw new Error(`Skill invocation turn not found: ${input.invokingTurnId}`);
  const skills = await input.loadSkillBodies(input.slugs);
  const artifacts = createSkillBodyArtifacts(
    input.threadId,
    input.invokingTurnId,
    nextTurnPosition(invokingTurn),
    skills,
  );
  return { kind: "created", turn: artifacts.turn, block: localBlockFromEvent(artifacts.block) };
}

async function createSkillBodyTurn(input: {
  deps: OrchestratorDeps;
  thread: Thread;
  threadId: ThreadId;
  invokingTurnId: TurnId | null;
  invokingTurnPosition: number | null;
  slugs: readonly string[];
}): Promise<{ turn: Turn; block: ReturnType<typeof contentForBlockInput> } | null> {
  if (input.slugs.length === 0) return null;
  if (!input.invokingTurnId || input.invokingTurnPosition === null)
    throw new Error("Activated skill body has no invoking turn");
  const skills = await Promise.all(
    input.slugs.map((slug) =>
      loadUserSkillBody({
        thread: input.thread,
        slug,
        agentRevisions: input.deps.agentRevisions,
        accountSkillInstalls: input.deps.accountSkillInstalls,
      }),
    ),
  );
  return createSkillBodyArtifacts(
    input.threadId,
    input.invokingTurnId,
    nextTurnPosition({ position: input.invokingTurnPosition }),
    skills,
  );
}

function createSkillBodyArtifacts(
  threadId: ThreadId,
  invokingTurnId: TurnId,
  position: number,
  skills: readonly ActivatedSkillBody[],
) {
  const turn = createLocalTurn({
    threadId,
    position,
    prevTurnId: invokingTurnId,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: SKILL_BODY_METADATA,
  });
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    sequence: 0,
    textContent: `<system_update>\n${formatInvokedSkills(skills)}\n</system_update>`,
    status: "complete",
  });
  return { turn, block };
}

type BuiltGenerateRequest = {
  request: GenerateRequest;
  agentSlug: string | null;
  thread: Thread;
  resolvedModel: AssembledNextTurnContext["resolvedModel"];
  permissionGate: PermissionGate;
};

function buildGenerateRequestFromAssembled(input: {
  assembled: AssembledNextTurnContext;
  runInput: RunLoopInput;
  gatewaySignal?: AbortSignal;
}): BuiltGenerateRequest {
  const { assembled } = input;
  return {
    thread: assembled.thread,
    agentSlug: assembled.agentSlug,
    resolvedModel: assembled.resolvedModel,
    permissionGate: permissionGateFromToolPolicy(
      assembled.policy,
      assembled.thread.kind === "subagent" ? ["return_result"] : [],
    ),
    request: {
      ...assembled.generateRequest,
      signal: input.gatewaySignal ?? input.runInput.signal,
    },
  };
}

/** Staged edits belong to a response scope, which rotates at a Work switch. */
function createResponseScope(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  turnId: TurnId;
  responseId: string;
  allBlocks: Block[];
}) {
  const { deps, threadId, turnId, allBlocks } = input;
  const writes = new Map<
    string,
    Array<{ block: Block; writeId: string; settlementId: string; uri: string | null }>
  >();
  let id = input.responseId;
  let active = true;
  return {
    get id() {
      return id;
    },
    get hasWrites() {
      return writes.size > 0;
    },
    rotate() {
      // Durable tool blocks keep the provider response id; only edit identity rotates.
      id = crypto.randomUUID();
      writes.clear();
      active = true;
    },
    stage(dispatched: Extract<Awaited<ReturnType<typeof dispatchToolCall>>, { block: Block }>) {
      const metadata = dispatched.metadata;
      if (metadata?.stagedWrite !== true || typeof metadata.documentId !== "string") return;
      if (typeof metadata.writeId !== "string" || typeof metadata.settlementId !== "string")
        throw new Error(
          `Staged write result missing write or settlement id for ${metadata.documentId}.`,
        );
      // Capture the source address before commit, not from a loosely typed block after apply.
      const [{ uri }] = metadata.documentRevisions as [DocumentRevisionEvidence];
      const blocks = writes.get(metadata.documentId) ?? [];
      blocks.push({
        uri,
        block: dispatched.block,
        writeId: metadata.writeId,
        settlementId: metadata.settlementId,
      });
      writes.set(metadata.documentId, blocks);
    },
    async commit() {
      const finalized: Array<{ write: { block: Block }; block: Block }> = [];
      const outcome = await deps.responseWrites.commitResponse(
        id,
        { threadId, turnId },
        async (settled) => {
          for (const [documentId, blocks] of writes) {
            for (const write of blocks) {
              const result =
                settled.status === "committed"
                  ? await persistCommittedWriteResult({
                      deps,
                      threadId,
                      block: write.block,
                      documentRevision: {
                        documentId,
                        uri: write.uri,
                        revision: settledReceipt(settled.receipts, documentId, write.settlementId)
                          .revision,
                      },
                      output: settledReceipt(settled.receipts, documentId, write.settlementId)
                        .result,
                    })
                  : await persistUncommittedWriteResult({
                      deps,
                      threadId,
                      block: write.block,
                      text: "The response closed before its staged write could commit. Re-read and retry.",
                    });
              finalized.push({ write, block: result.block });
            }
          }
        },
      );
      active = false;
      for (const { write, block } of finalized) {
        write.block = block;
        const index = allBlocks.findIndex((existing) => existing.id === block.id);
        if (index >= 0) allBlocks[index] = block;
      }
      return outcome;
    },
    async backfill(
      editsByDocument: Extract<
        ResponseWriteCommitOutcome,
        { status: "committed" }
      >["concurrentEdits"],
      remainingBytes: number,
    ) {
      const renderBudget = { remainingBytes };
      // Backfill body-complete concurrent runs into the last write result per document.
      for (const { documentId, concurrentEdits: edits } of editsByDocument) {
        const boundedEdits = applyConcurrentRenderBudget(edits, renderBudget);
        const block = writes.get(documentId)?.at(-1)?.block;
        if (!block) continue;
        const content = block.content as {
          toolCallId?: string;
          output?: unknown;
          isError?: boolean;
        } | null;
        if (!content?.output) continue;

        const output = content.output;
        if (!isAgentEditResultEnvelope(output)) continue;

        const updatedOutput = {
          ...output,
          concurrent: modelConcurrentResult(boundedEdits),
        };
        const updatedContent = {
          ...content,
          output: updatedOutput,
        };
        const updatedBlockRow = contentForBlockInput({
          id: block.id,
          turnId: block.turnId,
          responseId: block.responseId,
          blockType: "tool_result",
          sequence: block.sequence,
          content: toJsonValue(updatedContent),
          provider: block.provider,
          status: "complete",
        });
        const persistedBackfill = await persistAndAppendEvents(deps, input.threadId, async () => ({
          result: localBlockFromEvent(updatedBlockRow),
          events: [{ type: "block.upserted", block: updatedBlockRow }],
        }));
        const blockIndex = allBlocks.findIndex((existing) => existing.id === block.id);
        if (blockIndex >= 0) allBlocks[blockIndex] = persistedBackfill.result;
      }
    },
    async rollback() {
      if (!active) return;
      active = false;
      await deps.responseWrites.rollbackResponse(id, { threadId, turnId });
    },
  };
}

async function executeLoop(
  deps: OrchestratorDeps,
  input: RunLoopInput,
  thread: Thread,
  reservedTurn: Turn,
  /** Full ordered history before the assistant container, including drained messages. */
  initialTurns: Turn[],
  inheritedBlocks: Block[],
  initialContext: AssembledNextTurnContext,
  initialCompaction: CompactionDecision,
  initialExecutionAdmitted: boolean,
  treeBudget: TreeBudget,
): Promise<Turn> {
  const { gateway, repos, eventWriter } = deps;
  const eventSink = deps.eventSink;
  const turnAccounting = createTurnAccounting({ billingUsage: deps.billingUsage });
  const { prefixCacheStateFor } = createPrefixCacheStateService({ repos });

  // The loop is the only writer of the lease phase, so `authority.read` cannot
  // split-brain. Publishing is observational: a failure must not fail the turn,
  // it only leaves the phase briefly stale until the next boundary.
  async function publishPhase(phase: ThreadPhase): Promise<void> {
    const lease = input.lease;
    try {
      await deps.runClaim.publish(lease, phase);
    } catch (error) {
      emitEvent(eventSink, {
        level: "warn",
        source: "runtime.run-lease",
        name: "lease.publish_failed",
        correlation: { threadId: input.threadId, runId: lease.runId },
        payload: unknownToEventPayload(error),
      });
    }
  }

  let currentTurn: Turn = reservedTurn;
  let preparedContext: AssembledNextTurnContext | undefined = initialContext;
  let pendingSummaryResponses: import("../ports/conversation-summarizer.js").SummaryResponse[] = [];
  let pendingSummary: Parameters<typeof settleSummaryResponses>[0]["summary"];
  let responseScope: ReturnType<typeof createResponseScope> | undefined;
  const allTurns: Turn[] = [...initialTurns, reservedTurn];
  const allBlocks: Block[] = [
    ...inheritedBlocks,
    ...(await repos.blocks.listByThread(input.threadId)),
  ];
  // The reservation already prepared this request. Its first generation is not
  // another boundary: rows behind a waiting control cannot leapfrog the reply.
  let queuedDrain: Awaited<ReturnType<typeof drainInbox>> | undefined = {
    turns: [],
    blocks: [],
    events: [],
    ackIds: (await deps.delivery.readPendingProjection(input.threadId)).run?.messageIds ?? [],
  };
  let executionSelector: TurnId | null = initialExecutionAdmitted ? reservedTurn.id : null;
  let endTurnRequested = false;
  let terminalControl = false;
  let continuingTask = false;
  let activeCompactionRequired = true;
  let iteration = 0;
  // One emergency retry per reply, even across tool iterations and compaction splits.
  let retriedContextOverflow = false;

  function boundaryInput(forcedDecision?: ForcedCompactionDecision): DeliveryBoundary {
    return {
      lease: input.lease,
      currentTurn: currentTurn,
      current: { kind: "assistant" },
      // Turn-end controls defer to a new run; an assistant boundary here has a task to continue.
      continueTask: continuingTask || currentTurn.role === "assistant",
      admit: async (turn) => {
        if (
          thread.kind === "subagent" &&
          (!executionSelector ||
            !(await deps.repos.executionReports.findByExecution(thread.id, executionSelector)))
        ) {
          await admitRunExecution(deps, input, thread, turn.id);
          executionSelector = turn.id;
        }
      },
      signal: input.signal,
      knownTurnIds: new Set(allTurns.map((turn) => turn.id)),
      expectedLeafTurnId: allTurns.at(-1)?.id ?? null,
      prepareAdoptedTurn: async (turn, blocks) => {
        const withReferences = await prepareReferenceReads({
          deps,
          threadId: input.threadId,
          userTurnId: turn.id,
          assistantTurnId: currentTurn.id,
          blocks,
          signal: input.signal,
        });
        const skillBody = await prepareSkillBodies({
          deps,
          threadId: input.threadId,
          invokingTurnId: turn.id,
          existingTurns: [...allTurns, turn],
          slugs: readActivatedSkillSlugs(turn),
          loadSkillBodies,
        });
        return {
          blocks: withReferences.blocks,
          events: withReferences.events,
          extraTurns:
            skillBody.kind === "created"
              ? [{ turn: skillBody.turn, blocks: [skillBody.block] }]
              : skillBody.kind === "existing"
                ? [{ turn: skillBody.turn, blocks: [] }]
                : [],
        };
      },
      prepareNextContext: async (drain, _current, selection) => {
        // Run-start preparation already froze the first request before its
        // assistant turn was reserved. Do not resolve its assets a second
        // time before that request is sent.
        if (
          !forcedDecision &&
          !selection.control &&
          preparedContext &&
          drain.turns.length === 0 &&
          drain.blocks.length === 0
        ) {
          return { events: [], turns: [], blocks: [], requiresSplit: false };
        }
        const latestUserTurn =
          [...drain.turns].reverse().find((turn) => turn.role === "user") ??
          [...allTurns].reverse().find((turn) => turn.role === "user");
        const prepared = await prepareRequestContext({
          deps,
          thread,
          threadId: input.threadId,
          referenceTurnId: latestUserTurn?.id ?? currentTurn.id,
          currentTurnId: currentTurn.id,
          turns: [...allTurns, ...drain.turns],
          blocks: [...allBlocks, ...drain.blocks],
          baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
          readReferences: false,
          signal: input.signal,
          forcedDecision,
          assertNoResponseScope: () => {
            if (responseScope)
              throw new Error("Undo revision query requires no open response scope");
          },
          controls: selection.controls,
          followingBatches: selection.followingBatches,
          failedUndoIds: selection.failedUndoIds,
          continueAfterControls: selection.outstanding.length > 0 || !!selection.continueTask,
          pinnedRequestTurnIds: new Set(selection.outstanding.map((row) => row.id)),
        });
        thread = prepared.assembled.thread;
        preparedContext = prepared.assembled;
        return {
          events: prepared.events,
          undos: prepared.undos,
          adoptedIds: prepared.adoptedIds,
          turns: prepared.turns,
          blocks: prepared.blocks,
          requiresSplit: prepared.events.length > 0,
          compaction: prepared.compaction,
        };
      },
    };
  }
  async function acceptBoundary(
    result: AdoptedBatch<unknown>,
  ): Promise<Awaited<ReturnType<typeof drainInbox>>> {
    if (result.completed) {
      const index = allTurns.findIndex((turn) => turn.id === result.completed?.id);
      allTurns[index] = result.completed;
    }
    // A genuinely new input starts a new reply budget. Rebased context rows and
    // the compaction successor itself do not grant another emergency retry.
    if (
      result.split &&
      result.drain.turns.some(
        (turn) =>
          result.drain.ackIds.includes(turn.id) &&
          !allTurns.some((existing) => existing.id === turn.id),
      )
    )
      retriedContextOverflow = false;
    allTurns.push(...result.drain.turns);
    for (const block of result.drain.blocks) {
      const index = allBlocks.findIndex((existing) => existing.id === block.id);
      if (index < 0) allBlocks.push(block);
      else allBlocks[index] = block;
    }
    if (result.terminal) {
      currentTurn = result.next;
      terminalControl = true;
      return result.drain;
    }
    if (result.compaction && currentTurn.role === "assistant") continuingTask = true;
    if (result.split) {
      const next = result.next;
      allTurns.push(next);
      currentTurn = next;
      endTurnRequested = false;
      input.onCurrentTurnChanged?.({
        id: next.id,
        kind: currentTurnKind(next),
      });
    }
    if (result.preparationFailure !== undefined) {
      throw new RequestPreparationError(result.preparationFailure);
    }
    if (result.compaction) return compact(result.compaction);
    return result.drain;
  }

  async function compact(decision: Extract<CompactionDecision, { kind: "compact" }>) {
    activeCompactionRequired = decision.required;
    await publishPhase("compacting");
    const result = await executeCompaction({
      deps,
      assertNoResponseScope: () => {
        if (responseScope)
          throw new Error("Compaction revision query requires no open response scope");
      },
      input,
      thread,
      currentTurn: currentTurn,
      allTurns,
      allBlocks,
      boundary: boundaryInput(),
      decision,
      settleResponses: (rows) =>
        settleSummaryResponses({
          deps,
          thread,
          rows,
          summary: pendingSummary,
          accounting: turnAccounting,
          treeBudget,
        }),
      recordResponses: (rows, summarizer) => {
        pendingSummaryResponses = rows;
        pendingSummary = { turnId: currentTurn.id, summarizer };
      },
    });
    pendingSummaryResponses = [];
    pendingSummary = undefined;
    preparedContext = result.preparedContext;
    if (result.summaryBlock) allBlocks.push(localBlockFromEvent(result.summaryBlock));
    return acceptBoundary(result.successor);
  }

  async function rollbackActiveResponse(): Promise<void> {
    const scope = responseScope;
    responseScope = undefined;
    await scope?.rollback();
  }

  async function exitRun(continueOnPending: boolean, cause: TerminalCause): Promise<boolean> {
    const outcome = await deps.delivery.close({
      lease: input.lease,
      turnId: currentTurn.id,
      cause,
      settleSummaryResponses: () =>
        settleSummaryResponses({
          deps,
          thread,
          rows: pendingSummaryResponses,
          summary: pendingSummary,
          accounting: turnAccounting,
          treeBudget,
        }),
      ...(continueOnPending ? { continueWith: boundaryInput() } : {}),
    });
    if (outcome.kind === "split") {
      queuedDrain = await acceptBoundary(outcome.adopted);
      return true;
    }
    currentTurn = outcome.completion.turn;
    return false;
  }
  const cancelTerminal: TerminalCause = { kind: "cancelled", reason: "cancelled" };
  const errorTerminal = (error: MeridianError | string, reason?: string): TerminalCause => ({
    kind: "failed",
    reason: reason ?? (typeof error === "string" ? "runtime_error" : error.code),
    error,
  });
  const completeTerminal = (result: GenerateResult): TerminalCause => ({
    kind: "success",
    finishReason: result.finishReason,
  });

  // The one cancel exit: discard an in-flight response, then finalize through
  // `exitRun`. Every cancel site calls this so the rollback+cancel sequence
  // cannot diverge.
  async function cancelExit(): Promise<boolean> {
    await rollbackActiveResponse();
    return exitRun(false, cancelTerminal);
  }

  // One loader for request-only skill bodies: a writer start passes its
  // activated slugs on the input; a drained or mid-run adopted writer turn
  // reads them back off its persisted metadata.
  const loadSkillBodies = (slugs: readonly string[]) =>
    Promise.all(
      slugs.map((slug) =>
        loadUserSkillBody({
          thread,
          slug,
          agentRevisions: deps.agentRevisions,
          accountSkillInstalls: deps.accountSkillInstalls,
        }),
      ),
    );

  for (;;) {
    try {
      if (initialCompaction.kind === "compact") {
        const firstDecision = initialCompaction;
        initialCompaction = { kind: "generate" };
        queuedDrain = await acceptBoundary({
          next: currentTurn,
          split: false,
          drain: { turns: [], blocks: [], events: [], ackIds: [] },
          compaction: firstDecision,
        });
      }
      if (terminalControl) return currentTurn;
      // The in-process abort is the fast cancel path; the durable lease flag is the
      // cross-process one, read at each iteration's safe boundary. Either set means
      // the run exits, so no suppression state is needed.
      let leaseCancelled = false;
      const isCancelled = () => (input.signal?.aborted ?? false) || leaseCancelled;
      const interruptAutoResume = await resolveInterruptAutoResumePolicy(deps, thread);

      // Every cancellation/error path must persist terminal events, not just
      // return/throw, so subscribers see the turn lifecycle closure.
      async function iterate(): Promise<boolean> {
        iteration += 1;
        if (iteration > MAX_TURN_ITERATIONS) {
          return exitRun(false, errorTerminal("exceeded max tool iterations"));
        }

        // A cancel from another process has no local abort; the lease flag is the
        // only signal. Read it before acting so the interrupt's next turn starts
        // from a clean, already-released run.
        const status = await deps.runClaim.read(input.threadId);
        if (status.kind === "awake" && status.cancelRequested) leaseCancelled = true;
        if (isCancelled()) {
          return cancelExit();
        }

        const budgetError = await turnAccounting.assertPreIterationBudget(treeBudget, thread);
        if (budgetError) {
          return exitRun(false, errorTerminal(budgetError));
        }

        turnAccounting.recordIterationSpend(treeBudget);

        const gatewayAbort = new AbortController();
        let cancelRequested = isCancelled();
        if (input.signal) {
          input.signal.addEventListener(
            "abort",
            () => {
              cancelRequested = true;
              gatewayAbort.abort();
            },
            { once: true },
          );
        }

        const drain =
          queuedDrain ??
          (await acceptBoundary(await deps.delivery.splitAndContinue(boundaryInput())));

        queuedDrain = undefined;
        if (terminalControl) return false;

        if (!preparedContext)
          throw new Error("Request context must be prepared before assistant generation");
        const built = buildGenerateRequestFromAssembled({
          assembled: preparedContext,
          runInput: input,
          gatewaySignal: gatewayAbort.signal,
        });
        const usableWindowTokens = preparedContext.compactionUsableWindowTokens;
        preparedContext = undefined;
        thread = built.thread;
        const request = built.request;
        const gatewayCallId = crypto.randomUUID();
        request.correlation = {
          gatewayCallId,
          threadId: input.threadId,
          turnId: currentTurn.id,
          iteration: iteration - 1,
          ...(built.agentSlug ? { agentSlug: built.agentSlug } : {}),
        };

        // Notices, adopted-turn skill bodies, and image events are durable before
        // their assistant turn is reserved; the context uses only that history.
        const inboxAckIds = drain.ackIds;
        let predictedCacheState: PrefixCacheState;
        try {
          predictedCacheState = await prefixCacheStateFor({
            threadId: input.threadId,
            model: built.resolvedModel,
            now: Date.now(),
            knownLocalTurns: allTurns,
          });
        } catch (cause) {
          predictedCacheState = { state: "cold", reason: "facts_unavailable" };
          emitEvent(eventSink, {
            level: "warn",
            source: "runtime.orchestrator",
            name: "prefix_cache_state.derive_failed",
            correlation: { threadId: input.threadId, turnId: currentTurn.id },
            payload: unknownToEventPayload(cause),
          });
        }

        try {
          deps.modelRequestDebug.capture({
            gatewayCallId,
            threadId: input.threadId,
            turnId: currentTurn.id,
            iteration: iteration - 1,
            agentSlug: built.agentSlug,
            request,
            toolRegistry: deps.toolRegistry,
          });
        } catch (cause) {
          eventSink.emit({
            timestamp: new Date().toISOString(),
            level: "warn",
            source: "runtime.orchestrator",
            name: "model_request_debug.capture_failed",
            sensitivity: "safe",
            correlation: { threadId: input.threadId, turnId: currentTurn.id },
            payload: unknownToEventPayload(cause),
          });
        }

        // The gateway yields a self-terminating stream: a sequence of
        // text/reasoning/tool_call deltas followed by exactly one 'end'
        // (with the assembled GenerateResult) or one 'error'.
        // On cancel, abort the gateway call and drain through 'end' so partial
        // usage can be persisted before turn.cancelled.
        await publishPhase("generating");
        let result: GenerateResult | undefined;
        let streamModel = request.model ?? "unknown";
        const partialToolCalls = new Map<
          string,
          { toolName: string; arguments: string; targetRecorded: boolean }
        >();
        for await (const event of gateway.stream(request)) {
          if (isCancelled()) {
            cancelRequested = true;
          }

          if (thread.kind === "subagent" && event.type === "tool_call.delta") {
            let partialCall = partialToolCalls.get(event.id);
            const firstDelta = partialCall === undefined;
            if (!partialCall) {
              partialCall = { toolName: event.name, arguments: "", targetRecorded: false };
              partialToolCalls.set(event.id, partialCall);
            } else if (event.name) {
              // Some compatible providers split the tool name from the first
              // arguments chunk; keep the newest nonempty canonical name.
              partialCall.toolName = event.name;
            }

            if (!partialCall.targetRecorded) {
              partialCall.arguments += event.argumentsDelta;
              const partialInput = parsePartialToolActivityInput(
                partialCall.toolName,
                partialCall.arguments,
              );
              const hasTarget = hasPartialToolActivityTarget(partialCall.toolName, partialInput);
              if (
                (firstDelta && showsPartialToolActivityBeforeTarget(partialCall.toolName)) ||
                hasTarget
              ) {
                const currentTool = {
                  toolCallId: event.id,
                  toolName: partialCall.toolName,
                  input: partialInput,
                };
                await appendSubagentActivityForToolChangeBestEffort({
                  recordCurrentTool: () => deps.runClaim.setCurrentTool(input.lease, currentTool),
                  currentTool,
                  eventWriter,
                  readActivity: (threadId) =>
                    readThreadActivity(
                      {
                        threads: repos.threads,
                        statusReader: deps.runClaim,
                        executionReports: deps.repos.executionReports,
                      },
                      threadId,
                    ),
                  parentThreadId: thread.parentThreadId as ThreadId,
                  childThreadId: thread.id,
                  eventSink,
                });
                partialCall.targetRecorded = hasTarget;
                if (hasTarget) partialCall.arguments = "";
              }
            }
          }

          if (event.type === "start") {
            streamModel = event.model;
          }

          const mapped = mapStreamEvent(event);
          if (mapped) {
            await appendEvent(eventWriter, input.threadId, mapped);
          }

          if (event.type === "end") {
            result = event.result;
          }
          if (event.type === "error") {
            if (cancelRequested) {
              break;
            }
            if (event.code === "context_overflow") {
              // Partial output from the rejected request is not a completed tool group.
              // Keep its paid usage, but only prior completed responses remain in A.
              if (event.result) {
                const paid = await persistModelResponse({
                  deps,
                  runInput: input,
                  thread,
                  currentTurn,
                  result: { ...event.result, content: [], toolCalls: [], finishReason: "error" },
                  requestMessageCount: request.messages.length,
                  predictedCacheState,
                  treeBudget,
                  turnAccounting,
                  blockSeq: 0,
                  inboxAckIds: [],
                });
                currentTurn = paid.updatedTurn;
              }
              if (retriedContextOverflow) {
                return exitRun(false, {
                  kind: "failed",
                  reason: "context_window_exceeded",
                  error: writerFacingPreparationError(
                    new CompactionPreparationError("context_window_exceeded"),
                  ),
                  acknowledgeInbox: true,
                });
              }
              retriedContextOverflow = true;
              if (usableWindowTokens === null)
                throw new Error("Context overflow requires a resolved model");
              queuedDrain = await acceptBoundary(
                await deps.delivery.splitAndContinue(
                  boundaryInput({
                    kind: "compact",
                    trigger: "auto",
                    path: "cold",
                    fitLimitTokens: Math.min(usableWindowTokens, FLOW_ABSOLUTE_CEILING),
                  }),
                ),
              );
              return true;
            }
            return exitRun(
              false,
              errorTerminal(meridianErrorFromGateway(event.code, event.message, event.retryable)),
            );
          }
        }

        if (cancelRequested) {
          const settled = await settleCancelledResponse({
            deps,
            runInput: input,
            thread,
            currentTurn,
            treeBudget,
            turnAccounting,
            blockSeq: allBlocks.filter((b) => (b.turnId as string) === (currentTurn.id as string))
              .length,
            allBlocks,
            result,
            model: result?.model ?? streamModel,
            requestMessageCount: request.messages.length,
            predictedCacheState,
          });

          currentTurn = settled;
          return exitRun(false, cancelTerminal);
        }

        if (!result) {
          return exitRun(false, errorTerminal("Stream ended without result"));
        }

        // blockSeq is the turn-scoped display order. It starts at the blocks
        // already stored for this assistant turn and is handed to interrupt/tool
        // collaborators so later blocks remain contiguous.
        let blockSeq = allBlocks.filter(
          (b) => (b.turnId as string) === (currentTurn.id as string),
        ).length;
        const persistedResponse = await persistModelResponse({
          deps,
          runInput: input,
          thread,
          currentTurn,
          result,
          requestMessageCount: request.messages.length,
          predictedCacheState,
          treeBudget,
          turnAccounting,
          blockSeq,
          inboxAckIds,
        });
        currentTurn = persistedResponse.updatedTurn;
        blockSeq = persistedResponse.nextBlockSeq;
        const responseId = persistedResponse.responseId;
        const toolCallsFromResult = persistedResponse.toolCalls;
        allBlocks.push(...persistedResponse.createdBlocks);

        if (result.finishReason === "error") {
          return exitRun(false, errorTerminal("Model returned error finish reason"));
        }
        if (result.finishReason === "max_tokens") {
          return exitRun(false, errorTerminal("Model exhausted its output tokens", "max_tokens"));
        }

        // blockSeq continues across tool_result blocks so all blocks for this
        // turn are numbered contiguously regardless of which iteration
        // created them.
        if (result.finishReason === "tool_use" && toolCallsFromResult.length > 0) {
          const scope = createResponseScope({
            deps,
            threadId: input.threadId,
            turnId: currentTurn.id,
            responseId,
            allBlocks,
          });
          responseScope = scope;
          if (isCancelled()) {
            return cancelExit();
          }

          // Sequential dispatch is load-bearing: agent writes resolve against the runtime doc one
          // at a time, so overlapping self-writes compose or no_match instead of self-mangling.
          for (const call of toolCallsFromResult) {
            if (isCancelled()) {
              return cancelExit();
            }

            if (
              call.name === "work" &&
              call.arguments &&
              typeof call.arguments === "object" &&
              "command" in call.arguments &&
              call.arguments.command === "switch" &&
              scope.hasWrites
            ) {
              const boundary = await scope.commit();

              if (boundary.status === "draft_closed") {
                return exitRun(true, cancelTerminal);
              }
              scope.rotate();
            }

            // If denied, we still persist a tool_result block (with isError: true)
            // so the model sees the rejection in the next turn's context build.
            const decision = built.permissionGate.check(call.name, call.arguments);
            if (!decision.allowed) {
              const persistedRejection = await persistToolRejection({
                deps,
                threadId: input.threadId,
                turn: currentTurn,
                call,
                decision: { ...decision, category: "tool_denied" },
                blockSeq,
              });
              blockSeq = persistedRejection.nextBlockSeq;
              allBlocks.push(persistedRejection.block);

              continue;
            }

            await publishPhase("waiting");
            const interruptState = {
              thread,
              threadId: input.threadId,
              currentTurn: currentTurn,
              autoResume: interruptAutoResume,
              signal: input.signal,
              blockSeqRef: { value: blockSeq },
              allBlocks,
            };
            const interruptSession = createInterruptSession(
              {
                interruptRegistry: deps.interruptRegistry,
                interruptArtifacts: deps.interruptArtifacts,
                persistenceDeps: deps,
                eventSink,
              },
              interruptState,
            );
            const dispatched = await dispatchToolCall(
              {
                toolExecutor: deps.toolExecutor,
                childRunCoordinator: deps.childRunCoordinator,
                eventSink,
                persistenceDeps: deps,
                executionReports: deps.repos.executionReports,
                readSnapshot: deps.repos.readSnapshot,
                runClaim: deps.runClaim,
              },
              call,
              {
                thread,
                lease: input.lease,
                agentSlug: built.agentSlug,
                responseId,
                editResponseId: scope.id,
                state: interruptState,
                interruptSession,
                interruptAutoResume,
                treeBudget,
                blockSeqRef: interruptState.blockSeqRef,
                allTurns,
              },
            );
            currentTurn = interruptState.currentTurn;
            blockSeq = interruptState.blockSeqRef.value;

            if (!dispatched.cancelled) scope.stage(dispatched);
            if (dispatched.cancelled || isCancelled()) {
              return cancelExit();
            }
            if (dispatched.endTurn === true) endTurnRequested = true;
          }
          if (isCancelled()) {
            return cancelExit();
          }
          const concurrentEdits = await scope.commit();
          responseScope = undefined;

          if (concurrentEdits.status === "draft_closed") {
            return exitRun(true, cancelTerminal);
          }

          await scope.backfill(
            concurrentEdits.concurrentEdits,
            deps.concurrentRenderBudgetBytes?.(request) ?? Number.MAX_SAFE_INTEGER,
          );

          if (endTurnRequested) {
            // A child called return_result: the report is captured and persisted,
            // so the turn ends here instead of looping into another model round.
            // A message that landed in the exit window keeps the run going.
            return exitRun(true, completeTerminal(result));
          }

          return true;
        }

        return exitRun(true, completeTerminal(result));
      }
      while (await iterate()) {
        /* The next request starts only after its boundary commits. */
      }
    } catch (err) {
      try {
        await rollbackActiveResponse();
      } catch (rollbackError) {
        emitEvent(eventSink, {
          level: "warn",
          source: "runtime.orchestrator",
          name: "response_rollback.failed",
          correlation: { threadId: input.threadId },
          payload: unknownToEventPayload(rollbackError),
        });
        // Keep the original turn failure visible. rollbackResponse invalidates
        // staged runtimes before surfacing cleanup failures, so a second failure
        // here should not hide the error that broke the response.
      }
      const state = await deps.runClaim.read(input.threadId);
      if (input.signal?.aborted || (state?.kind === "awake" && state.cancelRequested)) {
        await exitRun(false, cancelTerminal);
      } else if (currentTurnKind(currentTurn) === "compaction") {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.compaction",
          name: "successor.failed",
          correlation: { threadId: input.threadId, turnId: currentTurn.id },
          payload: unknownToEventPayload(err),
        });
        const optional = !activeCompactionRequired;
        let failed: Awaited<ReturnType<typeof failCompactionSuccessor>>;
        try {
          failed = await failCompactionSuccessor({
            deps,
            threadId: input.threadId,
            placeholder: currentTurn,
            optional,
            boundary: boundaryInput(),
            settleResponses: () =>
              settleSummaryResponses({
                deps,
                thread,
                rows: pendingSummaryResponses,
                summary: pendingSummary,
                accounting: turnAccounting,
                treeBudget,
              }),
          });
        } catch (failure) {
          // A failed status read must not replace the terminal-commit marker.
          const latest = await deps.runClaim.read(input.threadId).catch(() => null);
          if (input.signal?.aborted || (latest?.kind === "awake" && latest.cancelRequested)) {
            await exitRun(false, cancelTerminal);
            return currentTurn;
          }
          throw failure;
        }
        pendingSummaryResponses = [];
        pendingSummary = undefined;
        queuedDrain = await acceptBoundary(failed);
        if (optional && !terminalControl) continue;
      } else if (
        err instanceof RequestPreparationError ||
        err instanceof ImageAssetResolutionError ||
        err instanceof ThreadConversationContextError
      ) {
        throw err instanceof RequestPreparationError ? err : new RequestPreparationError(err);
      } else {
        await exitRun(
          false,
          errorTerminal(err instanceof Error ? err.message : String(err), "execution_error"),
        );
      }
    } finally {
      await rollbackActiveResponse().catch((error) => {
        emitEvent(eventSink, {
          level: "warn",
          source: "runtime.orchestrator",
          name: "response_rollback.failed",
          correlation: { threadId: input.threadId },
          payload: unknownToEventPayload(error),
        });
      });
      // Helper result delivery is flushed by callers after their live-turn registry
      // is cleared. Draining here would race queued helper system turns into a
      // still-running parent thread.
    }
    break;
  }
  return currentTurn;
}
