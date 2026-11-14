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
 *   | permission.denied       | Tool outside the agent's tool policy        |
 *   | model.response_received | A model response is recorded                |
 *   | usage                   | Cumulative token/cost tick                  |
 *   | turn.completed          | Turn finishes successfully                  |
 *   | turn.cancelled          | Turn aborted via AbortSignal                |
 *   | turn.error              | Turn failed with an error                   |
 *
 * Depends on: gateway, tool executor, thread repositories, event journal.
 */

import { createReplyMutations } from "@meridian/agent-edit/integration";
import {
  isMeridianError,
  type MeridianError,
  meridianErrorFromGateway,
  meridianErrorFromSystem,
} from "@meridian/contracts/errors";
import type { ProjectId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget, type TreeBudget } from "@meridian/contracts/spawn";
import type {
  Block,
  JsonObject,
  ModelResponseReceivedRow,
  OrchestratorEvent,
  Thread,
  Turn,
} from "@meridian/contracts/threads";
import type {
  GenerateRequest,
  GenerateResult,
  Gateway as LlmGateway,
} from "@meridian-flow/gateway";
import { testHook } from "../../../shared/test-hooks.js";
import type { BillingUsagePolicy } from "../../billing/index.js";
import type { DocumentRevisions } from "../../context/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { AccountSkillInstallStore, AgentRevisionStore } from "../../packages/index.js";
import { isCacheReset } from "../../threads/domain/cache-reset.js";
import type {
  BlockRepository,
  LiveEventWriter,
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
import { turnGraph } from "../../threads/ports/turn-graph.js";
import type { AskService } from "../asks/ask-service.js";
import type { ModelTokenRateSource } from "../costing/pricing.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import type { ModelRequestDebugStore } from "../model-request-debug/index.js";
import type { ConversationSummarizer } from "../ports/conversation-summarizer.js";
import type { DocumentEvidence } from "../ports/document-evidence.js";
import type { HandoffBriefStopper } from "../ports/handoff-briefs.js";
import { MediaResolutionError, type MediaResolverPort } from "../ports/media-resolver.js";
import { appendSubagentActivityForToolChangeBestEffort } from "../spawn/activity-event.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import { admitRun, readContinuation } from "../spawn/run-admission.js";
import { resolveMaxSpawnDepth } from "../spawn/tree-budget.js";
import type { ToolExecutor, ToolRegistry } from "../tools/index.js";
import { jsonContent, textContent } from "../tools/tool-content.js";
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
import { isScratchCall, type NotesContinuation } from "./compaction/notes-step.js";
import {
  CompactionCancelledError,
  executeCompaction,
  recordCompactionSummary,
} from "./compaction-phase.js";
import { failCompactionSuccessor } from "./compaction-successor.js";
import { createDeltaJournal } from "./delta-journal.js";
import type { TerminalCause } from "./execution-finalizer.js";
import { decideForgetting, loadForgettingFacts } from "./forget-failed-attempt.js";
import { CreditedBlocks, frontierLookup } from "./frontier-recording.js";
import { type drainInbox, planMessageTurns } from "./inbox-context.js";
import {
  createLocalTurn,
  currentTurnKind,
  readCompactionTrigger,
  reservationTurn,
} from "./local-turn.js";
import { requestCarriesMediaLink } from "./media-link-window.js";
import { modelResponseTimingFields } from "./model-response-timing.js";
import {
  hasPartialToolActivityTarget,
  parsePartialToolActivityInput,
  showsPartialToolActivityBeforeTarget,
} from "./partial-tool-activity.js";
import { missingToolRefusal, type ToolPolicy } from "./permissions/index.js";
import { persistAndAppendEvents, persistAndAppendTurnStartEvents } from "./persistence.js";
import type { Lease, RunClaim, ThreadPhase } from "./ports.js";
import {
  createPrefixCacheStateService,
  linkWindowSeconds,
  type PrefixCacheState,
} from "./prefix-cache-state.js";
import {
  loadReferenceReads,
  type ReferenceEvidence,
  type ReferenceReader,
  recordReferenceEvidence,
} from "./reference-context.js";
import { prepareRequestContext } from "./request-preparation.js";
import {
  createRunSessions,
  type LineageCancellation,
  type RunSessionReports,
} from "./run-session.js";
import {
  type DrainRunLoopInput,
  isDrainRun,
  type PreparedLoop,
  type RunLoopInput,
} from "./run-turn-port.js";
import {
  type AdoptedBatch,
  type DeliveryBoundary,
  LostRunError,
  type RuntimeDelivery,
} from "./runtime-delivery.js";
import { settleSummaryResponses } from "./settle-summary-responses.js";
import {
  collectToolCalls,
  contentPartToBlockInput,
  mapStreamEvent,
  toJsonValue,
} from "./streaming.js";
import {
  dispatchToolCall,
  type RequestBatch,
  reduceToolBatch,
  type ToolDispatchOutcome,
} from "./tool-dispatch.js";
import { createTurnAccounting, type TurnAccounting } from "./turn-accounting.js";
import {
  type AssembledNextTurnContext,
  lazyThreadModel,
  persistPreparedPromptBake,
} from "./turn-context-assembly.js";
import type { WorkContextReader } from "./work-context.js";
import { persistWriterTurn } from "./writer-enqueue.js";

const MAX_TURN_ITERATIONS = 32;

class RequestPreparationError extends Error {
  constructor(readonly original: unknown) {
    super(
      original instanceof Error || isMeridianError(original) ? original.message : String(original),
      { cause: original },
    );
    this.name = "RequestPreparationError";
  }
}

function asPreparationFailure(error: unknown): Error | MeridianError {
  return error instanceof Error || isMeridianError(error)
    ? error
    : new Error(String(error), { cause: error });
}

function errorTerminal(error: MeridianError | string, reason?: string): TerminalCause {
  return {
    kind: "failed",
    reason: reason ?? (typeof error === "string" ? "runtime_error" : error.code),
    error,
  };
}

export interface OrchestratorRepositories {
  asks: ThreadRepositories["asks"];
  threads: ThreadRepository;
  turns: TurnRepository;
  promptBakes: ThreadRepositories["promptBakes"];
  mediaInclusions: ThreadRepositories["mediaInclusions"];
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
  /** One app-owned lifecycle tracker shared by every detached runtime caller. */
  backgroundTasks: DetachedWorkTracker;
  /** Shared app shutdown state read by run starts, wakes and handoff briefs. */
  shutdown: { started: boolean };
  summarizer: ConversationSummarizer;
  gateway: LlmGateway;
  toolExecutor: ToolExecutor;
  referenceReader: ReferenceReader;
  documentRevisions: DocumentRevisions;
  repos: OrchestratorRepositories;
  eventWriter: LiveEventWriter;
  headSeq(threadId: ThreadId): Promise<bigint>;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
  /** Lineage cancellation across processes: turn cancel, delete, and a child's terminal run end a subtree; Stop and Send now end only the reply. */
  lineage: LineageCancellation;
  askRequests: Pick<AskService, "request">;
  /** Runs after the ambient transaction commits, or at once outside one. */
  afterCommit(task: () => void): void;
  /** Child invocation cards: the saved report when the run ends. */
  reports: RunSessionReports;
  agentRevisions: Pick<
    AgentRevisionStore,
    "readThreadBinding" | "listInstallations" | "readSource" | "readRevision" | "recordInvokedSkill"
  >;
  accountSkillInstalls: Pick<AccountSkillInstallStore, "listByOwner">;
  toolRegistry: ToolRegistry;
  workContext: WorkContextReader;
  billingUsage: BillingUsagePolicy;
  rateSource: ModelTokenRateSource;
  childRunCoordinator: ChildRunCoordinator;
  eventSink: EventSink;
  wakeIfRunnable(threadId: ThreadId): Promise<void>;
  modelRequestDebug: ModelRequestDebugStore;
  /** Durable per-thread message queue drained into each model request. */
  delivery: RuntimeDelivery;
  handoffBriefs: HandoffBriefStopper;
  /** Session claim and observable lease lifetime. */
  runClaim: RunClaim;
  mediaResolver: MediaResolverPort;
  /** Test seam: the span a signed media link stays identical for, instead of the cache lifetime. */
  mediaLinkWindowSeconds?: number;
  /** What each tool result, settled receipt and reference read showed of a document, per room. */
  documentEvidence: DocumentEvidence;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  return createRunSessions({
    ...deps,
    setup: (input) => prepareLoop(deps, input),
    async finalizeFailure(input) {
      const error =
        input.error instanceof RequestPreparationError ? input.error.original : input.error;
      const contextError = error instanceof ThreadConversationContextError ? error : null;
      const mediaResolutionError = error instanceof MediaResolutionError ? error : null;
      const requestPreparationFailed = input.error instanceof RequestPreparationError;
      const shutdownAbort = input.signal?.reason === "shutdown";
      const failedTurn = await deps.repos.turns.findById(input.turnId);
      if (!failedTurn) throw new Error(`Failure turn not found: ${input.turnId}`);
      const outcome = await deps.delivery.close({
        lease: input.lease,
        turnId: input.turnId,
        cause: input.signal?.aborted
          ? shutdownAbort
            ? {
                kind: "failed",
                reason: "shutdown",
                error: "Runtime shut down before the response completed",
              }
            : { kind: "cancelled", reason: "cancelled" }
          : isMeridianError(error)
            ? errorTerminal(error)
            : {
                kind: "failed",
                reason:
                  (error instanceof CompactionPreparationError
                    ? error.reason
                    : contextError?.code) ??
                  (mediaResolutionError
                    ? "media_resolution_failed"
                    : requestPreparationFailed
                      ? "request_preparation_failed"
                      : "execution_error"),
                error: error instanceof Error ? error.message : String(error),
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
    if (isDrainRun(input)) await deps.delivery.blockForUsage(input.lease);
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
    ...(input.child
      ? agentRequestMetadata(input.child.origin, {
          threadId: input.child.parentThreadId,
          ...input.child.sender,
        })
      : {}),
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
      seedBlocks: input.seedBlocks,
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
        // A child's admission is its parent's machine wake: the enqueue checks the fence.
        ...(input.child
          ? {
              sender: {
                threadId: input.child.parentThreadId,
                executionId: input.child.parentExecutionId,
              },
            }
          : {}),
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
  const treeBudget =
    input.treeBudget ?? createDefaultTreeBudget({ maxDepth: resolveMaxSpawnDepth(process.env) });
  const accounting = createTurnAccounting({
    billingUsage: deps.billingUsage,
    rateSource: deps.rateSource,
  });
  let preparationError: Error | MeridianError | null = null;
  const setup = await deps.delivery.adoptBatch(
    input.lease,
    async (selection) => {
      const setupThread = await deps.repos.threads.findById(input.threadId);
      if (!setupThread) throw new Error(`Thread not found: ${input.threadId}`);
      const batch = selection.batch;
      const control = selection.next.kind === "control" ? selection.next.control : null;
      const hint = control?.body.kind === "ask_resolved" ? control.body : null;
      const read = hint ? await readContinuation(deps.repos.asks, input.threadId, hint) : null;
      if (read === "retire" && control) return { retire: [control.id] };
      const continuation = read === "retire" ? null : read;
      const requestControl =
        control?.body.kind === "ask_resolved"
          ? null
          : (control as import("./next-inbox-work.js").ControlMessage | null);
      if (selection.next.kind === "none" && !input.replyTurnId) return null;
      const ctx = await loadRunStartContext(deps, setupThread);
      preparationError = ctx.contextError;
      // Decide what this boundary forgets before anything is built over the history: the request, the
      // compaction plan and any summary leave those turns out. The append primitive decides again from the
      // events it commits and asserts the two agree.
      const forgetting = decideForgetting(
        await loadForgettingFacts(deps.repos, input.threadId, selection.activeLeafTurnId),
        {
          closes: true,
          reservationExecutionId: input.lease.executionId,
          retries: input.retryOf ?? null,
        },
      );
      const forgotten = new Set(forgetting.forget);
      const deferred = new Set(selection.deferred.map((message) => message.id));
      const stays = <T extends { id: string }>(turns: readonly T[]) =>
        turns.filter((turn) => !forgotten.has(turn.id) && !deferred.has(turn.id));
      const staysBlocks = (blocks: readonly Block[]) =>
        blocks.filter((block) => !forgotten.has(block.turnId) && !deferred.has(block.turnId));
      // `priorTurns` is the graph (the leaf, positions, known ids); `localTurns` the conversation.
      const { priorTurns, prevTurnId } = ctx;
      const localTurns = stays(ctx.localTurns);
      const inheritedTurns = stays(ctx.inheritedTurns);
      const inheritedBlocks = staysBlocks(ctx.inheritedBlocks);
      const existingTurns = [...inheritedTurns, ...priorTurns];
      const previousTurn = prevTurnId
        ? (existingTurns.find((turn) => turn.id === prevTurnId) ?? null)
        : null;
      if (prevTurnId && !previousTurn) throw new Error(`Missing causal turn: ${prevTurnId}`);
      const turnById = new Map(
        [...inheritedTurns, ...priorTurns].map((turn) => [turn.id as string, turn]),
      );
      // A Retry is reserved for its failed reply's messages. Those inbox rows
      // were acknowledged by the failure, so the execution carries them itself.
      const retryReservedFor = input.retryOf
        ? (turnById.get(input.retryOf)?.reservedForUserTurnIds ?? [])
        : [];
      const knownTurnIds = new Set([
        ...inheritedTurns.map((turn) => turn.id as TurnId),
        ...priorTurns.map((turn) => turn.id as TurnId),
      ]);
      let skillBody: ReturnType<typeof createSkillBodyArtifacts> | null = null;
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
      const activatedSkillSlugs = [
        ...new Set(
          batch.flatMap((message) => {
            const turn = turnById.get(message.id);
            return turn ? readActivatedSkillSlugs(turn) : [];
          }),
        ),
      ];
      const skillBodies = createSkillBodyPreparation(activatedSkillSlugs);
      if (!preparationError) {
        try {
          skillBody = await skillBodies.prepare({
            deps,
            thread: setupThread,
            threadId: input.threadId,
            invokingTurnId: prevTurnId,
            invokingTurnPosition: previousTurn?.position ?? null,
          });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          preparationError = asPreparationFailure(error);
        }
      }
      let plan = makePlan(preparationError ? [] : selection.notices);
      const referenceUserTurnId =
        [...plan.turns].reverse().find((turn) => turn.role === "user")?.id ??
        [...localTurns, ...inheritedTurns].reverse().find((turn) => turn.role === "user")?.id ??
        prevTurnId ??
        reservedTurnId;
      let preflight: Awaited<ReturnType<typeof prepareRequestContext>> | null = null;
      if (!preparationError) {
        try {
          const previousBlocks = staysBlocks(ctx.localBlocks);
          const prepareInput = {
            deps,
            thread: setupThread,
            threadId: input.threadId,
            referenceTurnId: referenceUserTurnId,
            currentTurnId: input.replyTurnId ?? reservedTurnId,
            control: requestControl,
            remainingIterations: Math.min(
              MAX_TURN_ITERATIONS,
              treeBudget.maxTotalTurns - treeBudget.spent.totalTurns,
            ),
            // A Retry-led compaction pins what it retries: those messages are not in the summary's words.
            pinnedRequestTurnIds: new Set([
              ...selection.outstanding.map((row) => row.id),
              ...retryReservedFor,
            ]),
            turns: [
              ...inheritedTurns,
              ...localTurns,
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
          };
          const eligibilityError = await accounting.assertContinuationEligibility(
            MAX_TURN_ITERATIONS,
            treeBudget,
            setupThread,
          );
          if (eligibilityError) throw eligibilityError;
          preflight = await prepareRequestContext(prepareInput);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          preparationError = asPreparationFailure(error);
        }
      }
      if (preparationError) {
        preflight = null;
        skillBody = null;
        plan = makePlan([]);
      }
      const preparedUpdateTurn = preflight?.turns.at(-1);
      const reservedTurn = reservationTurn(
        {
          id:
            preflight?.compaction.kind === "compact"
              ? crypto.randomUUID()
              : (input.replyTurnId ?? reservedTurnId),
          threadId: input.threadId,
          prevTurnId: preparedUpdateTurn?.id ?? plan.leafTurnId ?? skillBody?.turn.id ?? prevTurnId,
          position: nextTurnPosition(
            preparedUpdateTurn ?? plan.turns.at(-1) ?? skillBody?.turn ?? previousTurn,
          ),
          identity: {
            executionId: input.lease.executionId,
            reservedForUserTurnIds: [
              ...new Set([...retryReservedFor, ...selection.outstanding.map(({ id }) => id)]),
            ],
            ...(input.retryOf && input.replyTurnId
              ? { retry: { of: input.retryOf, replyTurnId: input.replyTurnId } }
              : {}),
          },
        },
        preflight?.compaction ?? { kind: "generate" },
      );
      if (preparationError && control?.body.kind === "compact") {
        reservedTurn.role = "compaction";
        reservedTurn.origin = "system";
        reservedTurn.status = "pending";
        reservedTurn.metadata = {
          trigger: "manual",
          controlMessageId: control.id,
          ...(control.body.instructions ? { instructions: control.body.instructions } : {}),
          ...(input.retryOf && input.replyTurnId
            ? { retryOf: input.retryOf, retryReplyId: input.replyTurnId }
            : {}),
        };
      }
      const value = {
        thread: setupThread,
        skillBodies,
        controlTurns: preflight?.turns ?? [],
        reservedTurn,
        skillBody,
        referenceUserTurnId,
        preflight,
        messageTurns: plan.turns,
        localTurns,
        inheritedTurns,
        inheritedBlocks,
        executionAdmitted:
          selection.outstanding.length > 0 || !!input.replyTurnId || !!continuation,
        // A start-time compaction hands the Retry's list on to the first assistant.
        carriedReservedFor: reservedTurn.role === "assistant" ? [] : retryReservedFor,
      };
      const events = [
        ...(skillBody
          ? [
              { type: "turn.created" as const, turn: skillBody.turn },
              { type: "block.upserted" as const, block: skillBody.block },
            ]
          : []),
        ...plan.events,
        ...(preflight?.events ?? []),
        { type: "turn.created" as const, turn: reservedTurn },
      ];
      return {
        value,
        turnId: reservedTurn.id,
        completedControlIds:
          control && (control.body.kind === "compact" || continuation) ? [control.id] : [],
        turnKind: currentTurnKind(reservedTurn),
        messageIds: [...batch.map(({ id }) => id)],
        ...(preparationError === null ? {} : { preparationFailure: preparationError }),
        persist: async () => {
          await persistAndAppendTurnStartEvents(
            deps,
            input.threadId,
            selection.activeLeafTurnId,
            async () => {
              if (preflight)
                await persistPreparedPromptBake(
                  preflight.assembled,
                  deps.repos.threads.bakeInitialPrompt.bind(deps.repos.threads),
                );
              // A reply holds the run claim, so the chat's mode can't change under it.
              reservedTurn.writeMode = setupThread.aiWriteMode;
              return {
                result: undefined,
                events,
              };
            },
            {
              expectedForgetting: forgetting,
              afterEvents: async () => {
                // The reference blocks in `events` are what this turn's request
                // shows; a discarded or retried preparation never gets here.
                if (preflight)
                  await recordReferenceEvidence(
                    deps,
                    {
                      projectId: setupThread.projectId as ProjectId,
                      threadId: input.threadId,
                      turnId: reservedTurn.id,
                    },
                    preflight.evidence,
                  );
                if (selection.outstanding.length > 0 || input.replyTurnId || continuation)
                  await admitRun(deps.repos, {
                    thread: setupThread,
                    executionTurnId: reservedTurn.id,
                    adopted: selection.outstanding,
                    continuation,
                    executionReport: input.executionReport,
                  });
              },
            },
          );
        },
      };
    },
    {
      signal: input.signal,
      retryOf: input.retryOf,
    },
  );

  const {
    reservedTurn,
    skillBody,
    referenceUserTurnId,
    preflight,
    messageTurns,
    localTurns,
    inheritedTurns,
    inheritedBlocks,
  } = setup;
  setup.skillBodies.committed(skillBody ? [skillBody.turn] : []);
  return {
    userTurnId: referenceUserTurnId,
    currentTurn: {
      id: reservedTurn.id,
      kind: currentTurnKind(reservedTurn),
    },
    execute: async () => {
      if (preparationError) throw new RequestPreparationError(preparationError);
      if (!preflight && reservedTurn.role !== "system")
        throw new Error("Request context is unavailable after preparation failed");
      return executeLoop({
        deps,
        input,
        thread: preflight?.assembled.thread ?? setup.thread,
        reservedTurn,
        initialTurns: [
          ...inheritedTurns,
          ...localTurns,
          ...(skillBody ? [skillBody.turn] : []),
          ...messageTurns,
          ...setup.controlTurns,
        ],
        inheritedBlocks,
        initialContext: preflight?.assembled,
        initialContinuation: preflight?.continuation ?? { kind: "ordinary" },
        initialCompaction: preflight?.compaction ?? { kind: "generate" },
        initialExecutionAdmitted: setup.executionAdmitted,
        carriedReservedFor: setup.carriedReservedFor,
        treeBudget,
        skillBodies: setup.skillBodies,
      });
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
  /** Every local turn: the graph, which owns the leaf, positions and known ids. */
  priorTurns: Turn[];
  /** The local conversation: the graph minus handed-back writer messages. */
  localTurns: Turn[];
  /** The conversation's own blocks, intersected with `localTurns`. */
  localBlocks: Block[];
  inheritedTurns: Turn[];
  inheritedBlocks: Block[];
  prevTurnId: TurnId | null;
  contextError: ThreadConversationContextError | null;
}> {
  const { repos } = deps;
  const priorTurns = await turnGraph(repos.turns).listByThread(thread.id);
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
      localTurns: await repos.turns.listByThread(thread.id),
      localBlocks: await repos.blocks.listByThread(thread.id),
      inheritedTurns: [],
      inheritedBlocks: [],
      prevTurnId: thread.activeLeafTurnId ?? priorTurns.at(-1)?.id ?? null,
      contextError: error,
    };
  }
  const { inherited, local } = conversation;
  const sortedLeaf = priorTurns.at(-1) ?? inherited.turns.at(-1) ?? null;
  // The durable leaf owns causal chaining; position owns transcript ordering.
  const prevTurnId = thread.activeLeafTurnId ?? sortedLeaf?.id ?? null;
  return {
    priorTurns,
    localTurns: local.turns,
    localBlocks: local.blocks,
    inheritedTurns: inherited.turns,
    inheritedBlocks: inherited.blocks,
    prevTurnId,
    contextError: null,
  };
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
  await testHook("response.beforeStore");
  const persistedResponse = await deps.delivery.ackWithResponse(
    runInput.lease,
    input.inboxAckIds,
    currentTurn,
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
  requestMessageCount: number;
  predictedCacheState: PrefixCacheState;
}): Promise<Turn> {
  let currentTurn = input.currentTurn;
  if (input.result) {
    const persistedResponse = await persistModelResponse({
      deps: input.deps,
      runInput: input.runInput,
      thread: input.thread,
      currentTurn,
      result: input.result,
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
  }
  return currentTurn;
}

async function persistToolOutcome(input: {
  deps: OrchestratorDeps;
  lease: Lease;
  threadId: ThreadId;
  turn: Turn;
  call: ReturnType<typeof collectToolCalls>[number];
  outcome: { kind: "permission_denied"; reason: string } | { kind: "notes_held" };
  blockSeq: number;
}): Promise<{ block: Block; nextBlockSeq: number }> {
  let blockSeq = input.blockSeq;
  const denied = input.outcome.kind === "permission_denied";
  const result: JsonObject =
    input.outcome.kind === "permission_denied"
      ? { error: "permission_denied", reason: input.outcome.reason }
      : { refusal: "notes_step" };
  const content = denied
    ? jsonContent(result)
    : textContent(
        "Not run: before compaction only Scratch operations within the 3-call budget execute. This call will not be replayed. Finish this step without tools to start the summary.",
      );
  const extraEvents: OrchestratorEvent[] =
    input.outcome.kind === "permission_denied"
      ? [
          {
            type: "permission.denied",
            toolCallId: input.call.id,
            toolName: input.call.name,
            category: "tool_denied",
            reason: input.outcome.reason,
          },
        ]
      : [];
  const persistedRejection = await input.deps.delivery.storeUnderLease(input.lease, () =>
    persistAndAppendEvents(input.deps, input.threadId, async () => {
      const block = contentForBlockInput({
        turnId: input.turn.id,
        blockType: "tool_result",
        sequence: blockSeq++,
        content: {
          toolCallId: input.call.id,
          content,
          result,
          isError: denied,
        },
        status: "complete",
      });
      return {
        result: localBlockFromEvent(block),
        events: [
          { type: "block.upserted", block },
          ...extraEvents,
          {
            type: "tool.result",
            toolCallId: input.call.id,
            content,
            result,
            isError: denied,
          },
        ],
      };
    }),
  );
  return {
    block: persistedRejection.result,
    nextBlockSeq: blockSeq,
  };
}

/**
 * Loads text-reference reads for one user turn, returning prepared events and
 * blocks with read results applied. Used both
 * at iteration 1 (the run's triggering turn) and when a mid-run drain adopts a
 * writer turn whose references were never read.
 */
async function prepareReferenceReads(input: {
  deps: OrchestratorDeps;
  thread: Thread;
  threadId: ThreadId;
  userTurnId: string;
  assistantTurnId: string;
  blocks: readonly Block[];
  /** What the reads are shown beside: their frontiers chain from these and the turn's own blocks. */
  credited: CreditedBlocks;
  signal?: AbortSignal;
}): Promise<{ blocks: Block[]; events: OrchestratorEvent[]; evidence: ReferenceEvidence }> {
  const { blocks: loaded, evidence } = await loadReferenceReads({
    blocks: input.blocks,
    userTurnId: input.userTurnId,
    threadId: input.threadId,
    assistantTurnId: input.assistantTurnId,
    reader: input.deps.referenceReader,
    model: lazyThreadModel({
      thread: input.thread,
      agentRevisions: input.deps.agentRevisions,
      threads: input.deps.repos.threads,
      toolRegistry: input.deps.toolRegistry,
      gateway: input.deps.gateway,
      baseTools: input.deps.toolExecutor.getDefinitions?.(),
    }),
    signal: input.signal,
    recordingFrontier: frontierLookup(
      input.deps,
      () => [...input.credited.ids(), ...input.blocks.map((block) => block.id)],
      { threadId: input.threadId, turnId: input.assistantTurnId },
    ),
  });
  if (loaded.length === 0) return { blocks: [...input.blocks], events: [], evidence };
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
    evidence,
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

/** Stage once per boundary attempt; only a committed body consumes the pending activations. */
function createSkillBodyPreparation(slugs: readonly string[]) {
  let pending = slugs;
  let stagedTurnId: TurnId | undefined;
  return {
    async prepare(input: {
      deps: OrchestratorDeps;
      thread: Thread;
      threadId: ThreadId;
      invokingTurnId: TurnId | null;
      invokingTurnPosition: number | null;
    }) {
      if (pending.length === 0) return null;
      if (!input.invokingTurnId || input.invokingTurnPosition === null)
        throw new Error("Activated skill body has no invoking turn");
      const skills = await Promise.all(
        pending.map((slug) =>
          loadUserSkillBody({
            thread: input.thread,
            slug,
            agentRevisions: input.deps.agentRevisions,
            accountSkillInstalls: input.deps.accountSkillInstalls,
          }),
        ),
      );
      const body = createSkillBodyArtifacts(
        input.threadId,
        input.invokingTurnId,
        nextTurnPosition({ position: input.invokingTurnPosition }),
        skills,
      );
      stagedTurnId = body.turn.id;
      return body;
    },
    committed(turns: readonly Turn[]) {
      if (turns.some((turn) => turn.id === stagedTurnId)) pending = [];
    },
  };
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
  policy: ToolPolicy;
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
    policy: assembled.policy,
    request: {
      ...assembled.generateRequest,
      signal: input.gatewaySignal ?? input.runInput.signal,
    },
  };
}

async function executeLoop({
  deps,
  input,
  thread,
  reservedTurn,
  initialTurns,
  inheritedBlocks,
  initialContext,
  initialCompaction,
  initialContinuation,
  initialExecutionAdmitted,
  carriedReservedFor: initialCarriedReservedFor,
  treeBudget,
  skillBodies,
}: {
  deps: OrchestratorDeps;
  input: RunLoopInput;
  thread: Thread;
  reservedTurn: Turn;
  /** Full ordered history before the assistant container, including drained messages. */
  initialTurns: Turn[];
  inheritedBlocks: Block[];
  initialContext: AssembledNextTurnContext | undefined;
  initialCompaction: CompactionDecision;
  initialContinuation: NotesContinuation;
  initialExecutionAdmitted: boolean;
  carriedReservedFor: readonly string[];
  treeBudget: TreeBudget;
  skillBodies: ReturnType<typeof createSkillBodyPreparation>;
}): Promise<Turn> {
  const { gateway, repos, eventWriter } = deps;
  const eventSink = deps.eventSink;
  const turnAccounting = createTurnAccounting({
    billingUsage: deps.billingUsage,
    rateSource: deps.rateSource,
  });
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
        correlation: { threadId: input.threadId, runId: lease.executionId },
        payload: unknownToEventPayload(error),
      });
    }
  }

  let currentTurn: Turn = reservedTurn;
  // Carried until the execution reserves its first assistant.
  let carriedReservedFor = initialCarriedReservedFor;
  const requestedReplyTurnId = "replyTurnId" in input ? input.replyTurnId : undefined;
  let preferredSuccessorTurnId =
    requestedReplyTurnId && reservedTurn.id !== requestedReplyTurnId
      ? requestedReplyTurnId
      : undefined;
  let preparedContext: AssembledNextTurnContext | undefined = initialContext;
  let continuation = initialContinuation;
  let pendingSummaryResponses: import("../ports/conversation-summarizer.js").SummaryResponse[] = [];
  let pendingSummary:
    | {
        kind: "compaction";
        turnId: TurnId;
        summarizer: import("../ports/conversation-summarizer.js").SummaryOutcome["summarizer"];
      }
    | undefined;

  async function settlePendingSummary(rows = pendingSummaryResponses) {
    if (pendingSummary) {
      const turn = await repos.turns.findById(pendingSummary.turnId);
      if (!turn) throw new Error("Summary placeholder disappeared");
      await recordCompactionSummary(deps, turn, pendingSummary.summarizer);
    }
    await settleSummaryResponses({ deps, thread, rows, accounting: turnAccounting, treeBudget });
  }
  const allTurns: Turn[] = [...initialTurns, reservedTurn];
  const credited = new CreditedBlocks(initialContext?.creditedBlockIds);
  // Only the blocks of the turns the request holds: a forgotten turn's blocks stay in the table.
  const requestTurnIds = new Set(allTurns.map((turn) => turn.id));
  const allBlocks: Block[] = [
    ...inheritedBlocks,
    ...(await repos.blocks.listByThread(input.threadId)).filter((block) =>
      requestTurnIds.has(block.turnId),
    ),
  ];
  // The reservation already prepared this request, so its first generation is
  // not another boundary.
  let queuedDrain: Awaited<ReturnType<typeof drainInbox>> | undefined = {
    turns: [],
    blocks: [],
    events: [],
    ackIds: (await deps.delivery.readPendingProjection(input.threadId)).run?.messageIds ?? [],
  };
  let executionSelector: TurnId | null = initialExecutionAdmitted ? reservedTurn.id : null;
  let terminalControl = false;
  // A message waits behind a queued write-mode switch: end the reply here.
  let yieldRequested = false;
  let continuingTask = false;
  let iteration = 0;
  let pendingCompletion: TerminalCause | undefined;
  let forcedCompaction: ForcedCompactionDecision | undefined;
  // One emergency retry per reply, even across tool iterations and compaction splits.
  let retriedContextOverflow = false;

  function boundaryInput(forcedDecision?: ForcedCompactionDecision): DeliveryBoundary {
    return {
      lease: input.lease,
      currentTurn: currentTurn,
      ...(preferredSuccessorTurnId ? { preferredSuccessorTurnId } : {}),
      ...(carriedReservedFor.length > 0
        ? { carriedReservedForUserTurnIds: carriedReservedFor }
        : {}),
      current: { kind: "assistant" },
      // Turn-end controls defer to a new run; an assistant boundary here has a task to continue.
      continueTask:
        continuingTask || currentTurn.role === "assistant" || !!preferredSuccessorTurnId,
      admit: async (turn, adopted) => {
        if (
          thread.kind === "subagent" &&
          (!executionSelector ||
            !(await deps.repos.executionReports.findByExecution(thread.id, executionSelector)))
        ) {
          await admitRun(deps.repos, {
            thread,
            executionTurnId: turn.id,
            adopted,
            continuation: null,
            executionReport: input.executionReport,
          });
          executionSelector = turn.id;
        }
      },
      signal: input.signal,
      knownTurnIds: new Set(allTurns.map((turn) => turn.id)),
      expectedLeafTurnId: allTurns.at(-1)?.id ?? null,
      recordEvidence: (turnId, evidence) =>
        recordReferenceEvidence(
          deps,
          { projectId: thread.projectId as ProjectId, threadId: input.threadId, turnId },
          evidence,
        ),
      prepareAdoptedTurn: async (turn, blocks) => {
        const withReferences = await prepareReferenceReads({
          deps,
          thread,
          threadId: input.threadId,
          userTurnId: turn.id,
          assistantTurnId: currentTurn.id,
          blocks,
          credited,
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
          evidence: withReferences.evidence,
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
          preparedContext &&
          continuation.kind !== "compaction_due" &&
          drain.turns.length === 0 &&
          drain.blocks.length === 0
        ) {
          return { events: [], turns: [], blocks: [], requiresSplit: false };
        }
        const leaf = drain.turns.at(-1) ?? allTurns.at(-1);
        const deferredSkillBody = await skillBodies.prepare({
          deps,
          thread,
          threadId: thread.id,
          invokingTurnId: leaf?.id ?? null,
          invokingTurnPosition: leaf?.position ?? null,
        });
        const latestUserTurn =
          [...drain.turns].reverse().find((turn) => turn.role === "user") ??
          [...allTurns].reverse().find((turn) => turn.role === "user");
        const skillEvents: OrchestratorEvent[] = deferredSkillBody
          ? [
              { type: "turn.created", turn: deferredSkillBody.turn },
              { type: "block.upserted", block: deferredSkillBody.block },
            ]
          : [];
        const skillTurns = deferredSkillBody ? [deferredSkillBody.turn] : [];
        const skillBlocks = deferredSkillBody ? [localBlockFromEvent(deferredSkillBody.block)] : [];
        const prepared = await prepareRequestContext({
          deps,
          thread,
          threadId: input.threadId,
          referenceTurnId: latestUserTurn?.id ?? currentTurn.id,
          currentTurnId: currentTurn.id,
          turns: [...allTurns, ...drain.turns, ...skillTurns],
          blocks: [...allBlocks, ...drain.blocks, ...skillBlocks],
          baseTools: input.tools ?? deps.toolExecutor.getDefinitions?.(),
          readReferences: false,
          continuation,
          remainingIterations: Math.min(
            MAX_TURN_ITERATIONS - iteration,
            treeBudget.maxTotalTurns - treeBudget.spent.totalTurns,
          ),
          signal: input.signal,
          forcedDecision,
          pinnedRequestTurnIds: new Set(selection.outstanding.map((row) => row.id)),
        });
        return {
          events: [...skillEvents, ...prepared.events],
          turns: [...skillTurns, ...prepared.turns],
          blocks: [...skillBlocks, ...prepared.blocks],
          requiresSplit: skillEvents.length + prepared.events.length > 0,
          compaction: prepared.compaction,
          context: { assembled: prepared.assembled, continuation: prepared.continuation },
        };
      },
    };
  }
  async function acceptBoundary(
    result: AdoptedBatch<unknown>,
  ): Promise<Awaited<ReturnType<typeof drainInbox>>> {
    if (result.split && result.next.id === preferredSuccessorTurnId)
      preferredSuccessorTurnId = undefined;
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
    skillBodies.committed(result.drain.turns);
    allTurns.push(...result.drain.turns);
    for (const block of [...(result.completedBlocks ?? []), ...result.drain.blocks]) {
      credited.add(block.id);
      const index = allBlocks.findIndex((existing) => existing.id === block.id);
      if (index < 0) allBlocks.push(block);
      else allBlocks[index] = block;
    }
    if (result.terminal) {
      currentTurn = result.next;
      terminalControl = true;
      // A compaction successor that failed preparation landed terminal and
      // ended the execution in the same commit; nothing is left to throw to.
      if (result.preparationFailure !== undefined)
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.orchestrator",
          name: "execution.failed",
          correlation: { threadId: input.threadId, turnId: result.next.id },
          payload: unknownToEventPayload(result.preparationFailure),
        });
      return result.drain;
    }
    if (result.yielded) {
      yieldRequested = true;
      return result.drain;
    }
    if (result.compaction && currentTurn.role === "assistant") continuingTask = true;
    if (result.split) {
      const next = result.next;
      allTurns.push(next);
      currentTurn = next;
      if (next.role === "assistant") carriedReservedFor = [];
      input.onCurrentTurnChanged?.({
        id: next.id,
        kind: currentTurnKind(next),
      });
    }
    if (result.preparationFailure !== undefined) {
      throw new RequestPreparationError(result.preparationFailure);
    }
    if (result.context) {
      preparedContext = result.context.assembled;
      thread = preparedContext.thread;
      continuation = result.context.continuation;
    }
    if (result.compaction) return compact(result.compaction);
    return result.drain;
  }

  async function compact(decision: Extract<CompactionDecision, { kind: "compact" }>) {
    continuation = { kind: "ordinary" };
    await publishPhase("compacting");
    const result = await executeCompaction({
      deps,
      input,
      thread,
      currentTurn: currentTurn,
      allTurns,
      allBlocks,
      boundary: boundaryInput(),
      decision,
      settleResponses: (rows) => settlePendingSummary(rows),
      recordResponses: (rows, summarizer) => {
        pendingSummaryResponses = rows;
        pendingSummary = { kind: "compaction", turnId: currentTurn.id, summarizer };
      },
    });
    pendingSummaryResponses = [];
    pendingSummary = undefined;
    return acceptBoundary(result.successor);
  }

  async function exitRun(continueOnPending: boolean, cause: TerminalCause): Promise<boolean> {
    if (continueOnPending && cause.kind === "success") {
      pendingCompletion = cause;
      return true;
    }
    const outcome = await deps.delivery.close({
      lease: input.lease,
      turnId: currentTurn.id,
      cause,
      localCancellation: () => (input.signal?.aborted ? abortTerminal() : null),
      settleSummaryResponses: () => settlePendingSummary(),
      continueOnPending,
    });
    if (outcome.kind === "continue") throw new Error("Terminal close cannot continue");
    currentTurn = outcome.completion.turn;
    return false;
  }
  const cancelTerminal: TerminalCause = { kind: "cancelled", reason: "cancelled" };
  const abortTerminal = (): TerminalCause =>
    input.signal?.reason === "shutdown"
      ? {
          kind: "failed",
          reason: "shutdown",
          error: "Runtime shut down before the response completed",
        }
      : cancelTerminal;
  const completeTerminal = (result: GenerateResult): TerminalCause => ({
    kind: "success",
    finishReason: result.finishReason,
  });
  // The yield ends A exactly as a steer split would, but releases the claim
  // instead of reserving a successor. Cancellation wins: the local signal is
  // read after the asynchronous boundary read, and close rereads both it and
  // the durable flag under the lock.
  const yieldExit = () =>
    input.signal?.aborted
      ? cancelExit()
      : exitRun(false, { kind: "success", finishReason: "end_turn" });

  const cancelExit = () => exitRun(false, abortTerminal());

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
      if (terminalControl) return currentTurn;
      // The in-process abort is the fast cancel path; the durable lease flag is the
      // cross-process one, read at each iteration's safe boundary. Either set means
      // the run exits, so no suppression state is needed.
      let leaseCancelled = false;
      const isCancelled = () => (input.signal?.aborted ?? false) || leaseCancelled;

      // Every cancellation/error path must persist terminal events, not just
      // return/throw, so subscribers see the turn lifecycle closure.
      async function iterate(): Promise<boolean> {
        // Before the budget and iteration checks, so a reply out of credits
        // still yields to the switch instead of failing.
        if (
          yieldRequested ||
          (!queuedDrain &&
            currentTurn.role === "assistant" &&
            (await deps.delivery.yieldsAtBoundary(input.threadId)))
        )
          return yieldExit();

        // A cancel from another process has no local abort; the lease flag is the
        // only signal. Read it before acting so the next admitted run starts
        // from a clean, already-released lease.
        const status = await deps.runClaim.read(input.threadId);
        if (status.kind === "awake" && status.cancelRequested) leaseCancelled = true;
        if (isCancelled()) {
          return cancelExit();
        }

        // Closure only asks whether input needs another request. No pending input
        // means a successful response stays successful, even after spending into debt.
        const completion = pendingCompletion;
        pendingCompletion = undefined;
        if (completion) {
          const closed = await deps.delivery.close({
            lease: input.lease,
            turnId: currentTurn.id,
            cause: completion,
            localCancellation: () => (isCancelled() ? abortTerminal() : null),
            settleSummaryResponses: () => settlePendingSummary(),
            continueOnPending: true,
          });
          if (closed.kind === "completed") {
            currentTurn = closed.completion.turn;
            return false;
          }
        }

        // All automatic continuations share this owner, including reply closure,
        // initial compaction and a forced overflow retry. This check spends nothing.
        const eligibilityError = await turnAccounting.assertContinuationEligibility(
          MAX_TURN_ITERATIONS - iteration,
          treeBudget,
          thread,
        );
        if (eligibilityError) return exitRun(false, errorTerminal(eligibilityError));

        const gatewayAbort = new AbortController();
        let cancelRequested = isCancelled();
        if (input.signal) {
          input.signal.addEventListener(
            "abort",
            () => {
              cancelRequested = true;
              gatewayAbort.abort(input.signal?.reason);
            },
            { once: true },
          );
        }

        const boundaryTurnId = currentTurn.id;
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
        let drain = queuedDrain;
        if (!drain) {
          const adopted = await deps.delivery.splitAndContinue(boundaryInput(forcedCompaction));
          forcedCompaction = undefined;
          // Input may have been withdrawn since close requested continuation.
          if (completion && !adopted.split) return exitRun(false, completion);
          drain = await acceptBoundary(adopted);
        }

        queuedDrain = undefined;
        if (terminalControl) return false;
        if (yieldRequested) return yieldExit();
        const acceptedStatus = await deps.runClaim.read(input.threadId);
        if (acceptedStatus.kind === "awake" && acceptedStatus.cancelRequested)
          leaseCancelled = true;
        if (isCancelled()) return cancelExit();
        // A summary may spend credits while moving to its successor. Ordinary
        // no-split boundaries have already checked eligibility above.
        if (currentTurn.id !== boundaryTurnId) {
          const budgetError = await turnAccounting.assertPreIterationBudget(treeBudget, thread);
          if (budgetError) return exitRun(false, errorTerminal(budgetError));
        }

        if (!preparedContext)
          throw new Error("Request context must be prepared before assistant generation");
        const built = buildGenerateRequestFromAssembled({
          assembled: preparedContext,
          runInput: input,
          gatewaySignal: gatewayAbort.signal,
        });
        const usableWindowTokens = preparedContext.compactionUsableWindowTokens;
        const requestCreditedIds = preparedContext.creditedBlockIds;
        preparedContext = undefined;
        // What credits is what this request carries (C10), so a compaction restarts the chain here.
        // Every call it produces plans on that set as of now (C4); results persisting later join `credited`.
        credited.reset(requestCreditedIds);
        const planningBlockIds = credited.ids();
        thread = built.thread;
        const request = built.request;
        const gatewayCallId = crypto.randomUUID();
        request.correlation = {
          gatewayCallId,
          threadId: input.threadId,
          turnId: currentTurn.id,
          iteration,
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
            ...(requestCarriesMediaLink(request)
              ? {
                  mediaLinkWindowSeconds: linkWindowSeconds(
                    built.resolvedModel,
                    thread.kind,
                    deps.mediaLinkWindowSeconds,
                  ),
                }
              : {}),
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
            iteration,
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
        const partialToolCalls = new Map<
          string,
          { toolName: string; arguments: string; targetRecorded: boolean }
        >();
        iteration += 1;
        turnAccounting.recordIterationSpend(treeBudget);
        const deltaJournal = createDeltaJournal({
          threadId: input.threadId,
          appendEvents: (threadId, events) => eventWriter.appendEvents(threadId, events),
          eventSink,
          scope: "model_request",
        });
        let streamFailure: { cause: unknown } | undefined;
        try {
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

            const mapped = mapStreamEvent(event);
            if (mapped) {
              await deltaJournal.push(mapped);
            }

            if (event.type === "end" || event.type === "error") {
              await deltaJournal.flush();
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
                    error: "Model context overflowed after compaction retry",
                  });
                }
                continuation = { kind: "ordinary" };
                retriedContextOverflow = true;
                if (usableWindowTokens === null)
                  throw new Error("Context overflow requires a resolved model");
                forcedCompaction = {
                  kind: "compact",
                  trigger: "auto",
                  knownTooLarge: true,
                  fitLimitTokens: Math.min(usableWindowTokens, FLOW_ABSOLUTE_CEILING),
                };
                return true;
              }
              return exitRun(false, {
                kind: "failed",
                reason: event.code,
                error: meridianErrorFromGateway(event.code, event.message, event.retryable),
                ...(event.providerError ? { providerError: event.providerError } : {}),
              });
            }
          }
        } catch (cause) {
          streamFailure = { cause };
          throw cause;
        } finally {
          deltaJournal.seal();
          try {
            await deltaJournal.flush();
          } catch (flushError) {
            // The flush is this stream scope's durable boundary. It replaces
            // normal control flow, but never an error already in flight.
            // biome-ignore lint/correctness/noUnsafeFinally: required failure precedence. slop-lint: allow suppression the reason is stated in this comment
            if (streamFailure === undefined) throw flushError;
            emitEvent(eventSink, {
              level: "error",
              source: "runtime.orchestrator",
              name: "delta_journal.flush_failed",
              correlation: { threadId: input.threadId, turnId: currentTurn.id },
              payload: unknownToEventPayload(flushError),
            });
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
            requestMessageCount: request.messages.length,
            predictedCacheState,
          });

          currentTurn = settled;
          return exitRun(false, abortTerminal());
        }

        if (!result) {
          return exitRun(false, errorTerminal("Stream ended without result"));
        }

        // blockSeq is the turn-scoped display order. It starts at the blocks
        // already stored for this assistant turn and is handed to persistence and
        // tool collaborators so later blocks remain contiguous.
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
          // The reply owns its own-mutation sequence until here, whichever way it ends.
          const reply = createReplyMutations();
          try {
            if (isCancelled()) {
              return cancelExit();
            }

            const batchOutcomes: ToolDispatchOutcome[] = [];
            const batch: RequestBatch = { deferred: null };
            // Sequential dispatch is load-bearing: agent writes resolve against the runtime doc one
            // at a time, so overlapping self-writes compose or no_match instead of self-mangling.
            for (const call of toolCallsFromResult) {
              if (isCancelled()) {
                return cancelExit();
              }

              if (continuation.kind === "notes") {
                const withinBudget = continuation.remaining > 0;
                continuation = {
                  ...continuation,
                  remaining: Math.max(0, continuation.remaining - 1),
                };
                if (!withinBudget || !isScratchCall(call)) {
                  const held = await persistToolOutcome({
                    deps,
                    lease: input.lease,
                    threadId: input.threadId,
                    turn: currentTurn,
                    call,
                    outcome: { kind: "notes_held" },
                    blockSeq,
                  });
                  blockSeq = held.nextBlockSeq;
                  allBlocks.push(held.block);
                  continue;
                }
              }

              // If denied, we still persist a tool_result block (with isError: true)
              // so the model sees the rejection in the next turn's context build.
              if (!built.policy.has(call.name)) {
                const persistedRejection = await persistToolOutcome({
                  deps,
                  lease: input.lease,
                  threadId: input.threadId,
                  turn: currentTurn,
                  call,
                  outcome: { kind: "permission_denied", reason: missingToolRefusal(call.name) },
                  blockSeq,
                });
                blockSeq = persistedRejection.nextBlockSeq;
                allBlocks.push(persistedRejection.block);

                continue;
              }

              await publishPhase("waiting");
              const blockSeqRef = { value: blockSeq };
              const dispatched = await dispatchToolCall(
                {
                  toolExecutor: deps.toolExecutor,
                  childRunCoordinator: deps.childRunCoordinator,
                  eventSink,
                  persistenceDeps: deps,
                  delivery: deps.delivery,
                  executionReports: deps.repos.executionReports,
                  readSnapshot: deps.repos.readSnapshot,
                  runClaim: deps.runClaim,
                  documentEvidence: deps.documentEvidence,
                  askRequests: deps.askRequests,
                },
                call,
                {
                  thread,
                  lease: input.lease,
                  agentSlug: built.agentSlug,
                  responseId,
                  threadId: input.threadId,
                  currentTurn,
                  signal: input.signal,
                  allBlocks,
                  treeBudget,
                  blockSeqRef,
                  allTurns,
                  planningBlockIds,
                  batch,
                  credited,
                  replyMutations: reply,
                  ...(built.resolvedModel ? { model: built.resolvedModel } : {}),
                },
              );
              blockSeq = blockSeqRef.value;

              if (dispatched.kind === "cancelled" || isCancelled()) return cancelExit();
              batchOutcomes.push(dispatched);
            }
            const batchDisposition = reduceToolBatch(batchOutcomes);
            if (isCancelled()) {
              return cancelExit();
            }
            if (continuation.kind === "notes") {
              if (continuation.remaining === 0) continuation = { kind: "compaction_due" };
              return true;
            }

            if (batchDisposition.kind === "end") {
              if (batchDisposition.cause === "asked") {
                return exitRun(false, {
                  kind: "asked",
                  askId: batchDisposition.askId,
                });
              }
              // A child called return_result: the report is captured and persisted,
              // so the turn ends here instead of looping into another model round.
              // A message that landed in the exit window keeps the run going.
              return exitRun(true, completeTerminal(result));
            }

            return true;
          } finally {
            reply.clear();
          }
        }

        if (continuation.kind === "notes") {
          continuation = { kind: "compaction_due" };
          return true;
        }
        return exitRun(true, completeTerminal(result));
      }
      while (await iterate()) {
        /* The next request starts only after its boundary commits. */
      }
    } catch (err) {
      if (err instanceof LostRunError) {
        // Another process took the run over and settled its turns: nothing here may write.
        currentTurn = (await deps.repos.turns.findById(currentTurn.id)) ?? currentTurn;
        return currentTurn;
      }
      // The execution's own row, whatever its expiry: Stop cancels an expired lease that is still held.
      const owned = await deps.runClaim.readOwned(input.lease);
      if (
        input.signal?.aborted ||
        err instanceof CompactionCancelledError ||
        owned?.cancelRequested
      ) {
        await exitRun(false, abortTerminal());
      } else if (currentTurnKind(currentTurn) === "compaction") {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.compaction",
          name: "successor.failed",
          correlation: { threadId: input.threadId, turnId: currentTurn.id },
          payload: unknownToEventPayload(err),
        });
        const optional = readCompactionTrigger(currentTurn.metadata) === "manual";
        let failed: Awaited<ReturnType<typeof failCompactionSuccessor>>;
        try {
          failed = await failCompactionSuccessor({
            deps,
            threadId: input.threadId,
            placeholder: currentTurn,
            failure: err,
            optional,
            boundary: boundaryInput(),
            settleResponses: () => settlePendingSummary(),
          });
        } catch (failure) {
          // A failed status read must not replace the terminal-commit marker.
          const latest = await deps.runClaim.read(input.threadId).catch(() => null);
          if (input.signal?.aborted || (latest?.kind === "awake" && latest.cancelRequested)) {
            await exitRun(false, abortTerminal());
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
        err instanceof MediaResolutionError ||
        err instanceof ThreadConversationContextError
      ) {
        throw err instanceof RequestPreparationError ? err : new RequestPreparationError(err);
      } else {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.orchestrator",
          name: "execution.failed",
          correlation: { threadId: input.threadId, turnId: currentTurn.id },
          payload: unknownToEventPayload(err),
        });
        await exitRun(
          false,
          errorTerminal(err instanceof Error ? err.message : String(err), "execution_error"),
        );
      }
    } finally {
      // Helper result delivery is flushed by callers after their live-turn registry
      // is cleared. Draining here would race queued helper system turns into a
      // still-running parent thread.
    }
    break;
  }
  return currentTurn;
}
