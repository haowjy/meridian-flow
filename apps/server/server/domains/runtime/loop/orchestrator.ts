/**
 * Orchestrator: the agentic turn loop — the runtime's core control loop.
 *
 * One invocation of `runTurn` handles a single user message through potentially
 * many LLM-call + tool-execution iterations, yielding an AsyncGenerator of
 * `OrchestratorEvent`s. Each iteration:
 *
 *   1. Builds context (Message[] + Tool[]) from the accumulated thread state.
 *   2. Calls the gateway's `stream(request)` and maps StreamEvent ->
 *      OrchestratorEvent via `mapStreamEvent` (streaming.ts).
 *   3. On stream end, persists the model response + generated content blocks
 *      in a transaction, then yields the persisted events.
 *   4. If finish_reason is "tool_use", checks permissions, executes each tool,
 *      persists tool_result blocks + events, and loops to step 1.
 *   5. Otherwise, finalizes the turn as complete/cancelled/error.
 *
 * Key design decisions:
 *
 * - **Persist-then-emit**: every state mutation goes through
 *   `persistAndAppendEvents` (repo transaction + journal append + read-model
 *   projection) before any event is yielded to the caller. No event is visible
 *   to subscribers until its backing read model is durable.
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
 *   iterations during a single turn.
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
import type { Notice, NoticePort } from "../../notices/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { AccountSkillInstallStore, AgentRevisionStore } from "../../packages/index.js";
import type { WorkContextDelivery } from "../../projects/index.js";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type {
  ActiveDocumentResolver,
  BlockRepository,
  EventJournalWriter,
  ModelResponseRepository,
  ThreadRepository,
  TurnRepository,
} from "../../threads/index.js";
import type { GenerateRequest, GenerateResult, Gateway as LlmGateway } from "../gateway/index.js";
import type { ModelRequestDebugStore } from "../model-request-debug/index.js";
import type { ImageAssetPort } from "../ports/image-asset.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import { resolveMaxSpawnDepth } from "../spawn/tree-budget.js";
import type { ToolExecutor, ToolRegistry } from "../tools/index.js";
import { readActivatedSkillSlugs } from "./activated-skills.js";
import { loadUserSkillBody } from "./available-skills.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { closeRun } from "./close-run.js";
import {
  attachNoticesToLatestUserMessage,
  attachSkillBodiesToLatestUserMessage,
  insertPostToolNotices,
  lastUserMessageIndex,
} from "./context-builder.js";
import {
  finalizeCancelled,
  finalizeError,
  finalizeTurnOnGeneratorFailure,
} from "./finalization.js";
import { loadThreadConversationContext } from "./fork-thread-context.js";
import { drainInbox, messageTurnFor } from "./inbox-context.js";
import { createInterruptSession, type InterruptArtifactFlushPort } from "./interrupt-session.js";
import {
  defaultInterruptAutoResumePolicy,
  type InterruptAutoResumePolicy,
  type InterruptRegistry,
} from "./interrupts.js";
import { createLocalTurn } from "./local-turn.js";
import { type PermissionGate, permissionGateFromToolPolicy } from "./permissions/index.js";
import {
  appendEvent,
  persistAndAppendEvents,
  persistAndAppendTurnStartEvents,
} from "./persistence.js";
import type { Inbox, RunAuthority, ThreadPhase } from "./ports.js";
import { loadReferenceReads, type ReferenceReader } from "./reference-context.js";
import {
  type DrainRunTurnInput,
  isDrainRun,
  NoPendingWakeError,
  type RunTurnHandle,
  type RunTurnInput,
  type RunTurnPort,
} from "./run-turn-port.js";
import {
  collectToolCalls,
  contentPartToBlockInput,
  mapStreamEvent,
  toJsonValue,
} from "./streaming.js";
import type { ThreadLock } from "./thread-lock.js";
import { dispatchToolCall } from "./tool-dispatch.js";
import { createTurnAccounting, type TurnAccounting } from "./turn-accounting.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";
import { writerUserTurnBlocks } from "./user-turn-blocks.js";
import type { WorkContextReader } from "./work-context.js";

const MAX_TURN_ITERATIONS = 32;

export interface OrchestratorRepositories {
  threads: ThreadRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  runTurnStartTransition<T>(
    threadId: ThreadId,
    expectedActiveLeafTurnId: TurnId | null,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface OrchestratorDeps {
  gateway: LlmGateway;
  toolExecutor: ToolExecutor;
  referenceReader: ReferenceReader;
  repos: OrchestratorRepositories;
  eventWriter: EventJournalWriter;
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
  workContextDelivery: Pick<WorkContextDelivery, "deliverNow">;
  interruptRegistry: InterruptRegistry;
  eventSink: EventSink;
  modelRequestDebug: ModelRequestDebugStore;
  notices: NoticePort;
  /** Durable per-thread message queue drained into each model request. */
  inbox: Inbox;
  /** The per-thread serialization lock the producer `ThreadedInbox` also takes. */
  threadLock: ThreadLock;
  /** Releases the run's lease through `closeRun` when the queue is empty. */
  runAuthority: RunAuthority;
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

/** The terminal write a run exit runs under the thread lock before releasing. */
type TerminalOutcome = { turn?: Turn; events: OrchestratorEvent[] };

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

export function createOrchestrator(deps: OrchestratorDeps): RunTurnPort {
  return {
    runTurn(input: RunTurnInput): Promise<RunTurnHandle> {
      return runTurn(deps, input);
    },
    async finalizeGeneratorFailure(input) {
      await finalizeTurnOnGeneratorFailure(deps, input);
    },
  };
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

// This direct append path is limited to ephemeral transport facts that do not
// require read-model projection.
async function* emit(
  writer: EventJournalWriter,
  threadId: ThreadId,
  event: OrchestratorEvent,
): AsyncGenerator<OrchestratorEvent> {
  yield await appendEvent(writer, threadId, event);
}

/**
 * Creates the user and assistant turns, then returns a handle with IDs and
 * an event generator. The caller can capture IDs immediately (both turn IDs
 * are known after the setup transaction commits), then consume the generator
 * on its own schedule.
 *
 * Setup order: thread status -> "active", then the user turn + user block +
 * assistant turn are persisted atomically. This guarantees the thread is
 * marked active before any subscriber sees the assistant turn.created event
 * and starts expecting streaming deltas.
 */
export async function runTurn(deps: OrchestratorDeps, input: RunTurnInput): Promise<RunTurnHandle> {
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
    return runDrainTurn(deps, input, thread);
  }

  const setup = await persistAndAppendTurnStartEvents(
    deps,
    input.threadId,
    thread.activeLeafTurnId,
    async () => {
      const { priorTurns, inheritedTurns, inheritedBlocks, prevTurnId } = await loadRunStartContext(
        deps,
        thread,
      );
      // Read inside the setup transaction so the turn's durable write vocabulary
      // matches the mode in effect at the moment the turn was minted.
      const writeMode = thread.workId ? await deps.workWriteMode.read(thread.workId) : "direct";
      const userTurn = createLocalTurn({
        threadId: input.threadId,
        prevTurnId,
        role: "user",
        status: "complete",
        metadata: input.userTurnMetadata ?? null,
      });
      const userBlocks = writerUserTurnBlocks(
        userTurn.id,
        input.userBlocks ?? [{ type: "text", text: input.userText }],
      );

      const assistantTurn = createLocalTurn({
        threadId: input.threadId,
        prevTurnId: userTurn.id,
        role: "assistant",
        status: "streaming",
        writeMode,
      });

      return {
        result: { userTurn, assistantTurn, priorTurns, inheritedTurns, inheritedBlocks },
        events: [
          { type: "turn.created", turn: userTurn },
          ...userBlocks.map((block) => ({ type: "block.upserted" as const, block })),
          { type: "turn.created", turn: assistantTurn },
        ],
      };
    },
  );

  const { userTurn, assistantTurn, priorTurns, inheritedTurns, inheritedBlocks } = setup.result;
  return {
    userTurnId: userTurn.id,
    assistantTurnId: assistantTurn.id,
    events: generateEvents(
      deps,
      input,
      thread,
      userTurn.id,
      assistantTurn,
      [...inheritedTurns, ...priorTurns, userTurn],
      inheritedBlocks,
      setup.events,
      input.treeBudget ?? createDefaultTreeBudget({ maxDepth: resolveMaxSpawnDepth(process.env) }),
      input.activatedSkillSlugs,
    ),
  };
}

/**
 * Drain-only start: a wake begins with no new writer turn. In one transition it
 * claims the pending inbox batch, persists each fresh message as a user-role turn
 * chained from the thread leaf, then mints the assistant container chained from
 * the last message. The durable chain is `leaf → message(user) → assistant(streaming)`
 * and the generator's request is built over exactly the drained batch. A redelivered
 * message already persisted by a crashed run is not re-appended; its existing turn
 * rides in `priorTurns`. No durable pending message means no turn to generate.
 */
async function runDrainTurn(
  deps: OrchestratorDeps,
  input: DrainRunTurnInput,
  thread: Thread,
): Promise<RunTurnHandle> {
  const setup = await persistAndAppendTurnStartEvents(
    deps,
    input.threadId,
    thread.activeLeafTurnId,
    async () => {
      const { priorTurns, inheritedTurns, inheritedBlocks, prevTurnId } = await loadRunStartContext(
        deps,
        thread,
      );
      const knownTurnIds = new Set<string>([
        ...inheritedTurns.map((turn) => turn.id),
        ...priorTurns.map((turn) => turn.id),
      ]);

      const batch = await deps.inbox.claimPending(input.threadId);
      const messages = batch.filter((message) => message.intent === "message");
      // The wake sweep only starts a thread with a derived wake need; a race that
      // drains the last message first must leave no phantom assistant turn behind.
      if (messages.length === 0) throw new NoPendingWakeError(input.threadId);

      // A writer send persisted its turn at enqueue with its activated skill
      // slugs stamped on the turn; read them back so the drain inlines the
      // bodies into the writer's message. A fresh non-writer message carries none.
      const turnById = new Map(
        [...inheritedTurns, ...priorTurns].map((turn) => [turn.id as string, turn]),
      );
      const activatedSkillSlugs = [
        ...new Set(
          messages.flatMap((message) => {
            const turn = turnById.get(message.id);
            return turn ? readActivatedSkillSlugs(turn) : [];
          }),
        ),
      ];

      const writeMode = thread.workId ? await deps.workWriteMode.read(thread.workId) : "direct";
      const events: OrchestratorEvent[] = [];
      const messageTurns: Turn[] = [];
      let leafTurnId = prevTurnId;
      for (const message of messages) {
        if (knownTurnIds.has(message.id)) continue;
        const { turn, block } = messageTurnFor(message, leafTurnId);
        messageTurns.push(turn);
        events.push({ type: "turn.created", turn }, { type: "block.upserted", block });
        leafTurnId = turn.id;
      }

      const assistantTurn = createLocalTurn({
        threadId: input.threadId,
        prevTurnId: leafTurnId,
        role: "assistant",
        status: "streaming",
        writeMode,
      });
      events.push({ type: "turn.created", turn: assistantTurn });

      return {
        result: {
          assistantTurn,
          referenceUserTurnId: leafTurnId ?? assistantTurn.id,
          messageTurns,
          priorTurns,
          inheritedTurns,
          inheritedBlocks,
          activatedSkillSlugs,
        },
        events,
      };
    },
  );

  const {
    assistantTurn,
    referenceUserTurnId,
    messageTurns,
    priorTurns,
    inheritedTurns,
    inheritedBlocks,
    activatedSkillSlugs,
  } = setup.result;
  return {
    userTurnId: referenceUserTurnId,
    assistantTurnId: assistantTurn.id,
    events: generateEvents(
      deps,
      input,
      thread,
      referenceUserTurnId,
      assistantTurn,
      [...inheritedTurns, ...priorTurns, ...messageTurns],
      inheritedBlocks,
      setup.events,
      input.treeBudget ?? createDefaultTreeBudget({ maxDepth: resolveMaxSpawnDepth(process.env) }),
      activatedSkillSlugs.length > 0 ? activatedSkillSlugs : undefined,
    ),
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
}> {
  const { repos } = deps;
  await reconcileOrphanedPendingWrites(deps, thread.id);
  const priorTurns = await repos.turns.listByThread(thread.id);
  const conversation = await loadThreadConversationContext(
    { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
    thread,
  );
  const inheritedTurnCount = Math.max(0, conversation.turns.length - priorTurns.length);
  const inheritedTurns = conversation.turns.slice(0, inheritedTurnCount);
  const inheritedTurnIds = new Set(inheritedTurns.map((turn) => turn.id));
  const inheritedBlocks = conversation.blocks.filter((block) => inheritedTurnIds.has(block.turnId));
  const sortedLeaf = priorTurns.at(-1) ?? inheritedTurns.at(-1) ?? null;
  // Chain from the durable leaf when present: `priorTurns` sorts by `createdAt`,
  // which can disagree with `activeLeafTurnId` after a restart or an
  // equal-timestamp batch, which would fork the turn chain.
  const prevTurnId = thread.activeLeafTurnId ?? sortedLeaf?.id ?? null;
  return { priorTurns, inheritedTurns, inheritedBlocks, prevTurnId };
}

async function reconcileOrphanedPendingWrites(
  deps: OrchestratorDeps,
  threadId: ThreadId,
): Promise<void> {
  const blocks = await deps.repos.blocks.listByThread(threadId);
  for (const block of blocks) {
    if (block.blockType !== "tool_result" || block.pruned) continue;
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
  runInput: RunTurnInput;
  thread: Thread;
  currentAssistantTurn: Turn;
  result: GenerateResult;
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
  events: OrchestratorEvent[];
}> {
  const { deps, runInput, thread, currentAssistantTurn, result, treeBudget, turnAccounting } =
    input;
  let blockSeq = input.blockSeq;
  const responseSeq = currentAssistantTurn.responseCount;
  const toolCalls = collectToolCalls(result);
  const persistedResponse = await persistAndAppendEvents(deps, runInput.threadId, async () => {
    const responseId = crypto.randomUUID();
    const computedCost = await turnAccounting.computeAndDebit(
      result,
      thread,
      runInput.threadId,
      currentAssistantTurn.id,
      treeBudget,
      responseId,
    );
    const costUsd = computedCost.costUsd;
    const response: ModelResponseReceivedRow = {
      id: responseId,
      turnId: currentAssistantTurn.id,
      sequence: responseSeq,
      provider: result.provider,
      model: result.model,
      providerRequestId: result.providerRequestId ?? null,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens ?? null,
      cacheReadTokens: result.usage.cacheReadTokens ?? null,
      cacheWriteTokens: result.usage.cacheWriteTokens ?? null,
      costUsd,
      millicredits: computedCost.millicredits,
      priceSource: computedCost.priceSource,
      pricingSnapshot: computedCost.pricingSnapshot,
      finishReason: result.finishReason,
      rawUsage: toJsonValue(result.usage),
    };
    const updatedTurn = applyResponseToTurnSnapshot(currentAssistantTurn, response);

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

    // Ack the batch in the same transaction that persists the response carrying
    // it; a crash before commit redelivers and the idempotency key collapses.
    await deps.inbox.ack(runInput.threadId, input.inboxAckIds);

    return {
      result: { responseId, updatedTurn, createdBlocks },
      events,
    };
  });

  return {
    responseId: persistedResponse.result.responseId,
    updatedTurn: persistedResponse.result.updatedTurn,
    createdBlocks: persistedResponse.result.createdBlocks,
    toolCalls,
    nextBlockSeq: blockSeq,
    events: persistedResponse.events,
  };
}

/**
 * Persists the partial usage a cancelled stream produced before the terminal
 * cancel write. Kept separate from `finalizeCancelled` so a pending message at
 * the exit still settles the aborted response, then continues the run; only the
 * cancel write itself is gated by `closeRun`.
 */
async function settleCancelledResponse(input: {
  deps: OrchestratorDeps;
  runInput: RunTurnInput;
  thread: Thread;
  currentAssistantTurn: Turn;
  treeBudget: TreeBudget;
  turnAccounting: TurnAccounting;
  blockSeq: number;
  allBlocks: Block[];
  result: GenerateResult | undefined;
  model: string;
}): Promise<{ events: OrchestratorEvent[]; turn: Turn }> {
  const settlement = await input.deps.gateway.settleCancelledResult?.({
    model: input.model,
    ...(input.result ? { result: input.result } : {}),
    ...(input.result?.providerRequestId
      ? { providerRequestId: input.result.providerRequestId }
      : {}),
  });

  let currentAssistantTurn = input.currentAssistantTurn;
  const events: OrchestratorEvent[] = [];
  if (settlement?.persist) {
    const persistedResponse = await persistModelResponse({
      deps: input.deps,
      runInput: input.runInput,
      thread: input.thread,
      currentAssistantTurn,
      result: settlement.result,
      treeBudget: input.treeBudget,
      turnAccounting: input.turnAccounting,
      blockSeq: input.blockSeq,
      // A cancelled run leaves its drained batch unacked so it redelivers.
      inboxAckIds: [],
    });
    currentAssistantTurn = persistedResponse.updatedTurn;
    input.allBlocks.push(...persistedResponse.createdBlocks);
    events.push(...persistedResponse.events);
    await input.deps.responseWrites.rollbackResponse(persistedResponse.responseId, {
      threadId: input.runInput.threadId,
      turnId: currentAssistantTurn.id,
    });
  }
  return { events, turn: currentAssistantTurn };
}

async function persistPermissionDenial(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  turn: Turn;
  call: ReturnType<typeof collectToolCalls>[number];
  decision: {
    allowed: false;
    category: Extract<OrchestratorEvent, { type: "permission.denied" }>["category"];
    reason: string;
  };
  blockSeq: number;
}): Promise<{ block: Block; nextBlockSeq: number; events: OrchestratorEvent[] }> {
  let blockSeq = input.blockSeq;
  const denialOutput = {
    error: "permission_denied",
    reason: input.decision.reason,
  };
  const persistedDenial = await persistAndAppendEvents(input.deps, input.threadId, async () => {
    const block = contentForBlockInput({
      turnId: input.turn.id,
      blockType: "tool_result",
      sequence: blockSeq++,
      content: {
        toolCallId: input.call.id,
        output: denialOutput,
        isError: true,
      },
      status: "complete",
    });
    return {
      result: localBlockFromEvent(block),
      events: [
        { type: "block.upserted", block },
        {
          type: "permission.denied",
          toolCallId: input.call.id,
          toolName: input.call.name,
          category: input.decision.category,
          reason: input.decision.reason,
        },
        {
          type: "tool.result",
          toolCallId: input.call.id,
          output: denialOutput,
          isError: true,
        },
      ],
    };
  });
  return { block: persistedDenial.result, nextBlockSeq: blockSeq, events: persistedDenial.events };
}

async function persistUncommittedWriteResult(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  block: Block;
  text: string;
}): Promise<{ block: Block; events: OrchestratorEvent[] }> {
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
  return { block: persisted.result, events: persisted.events };
}

async function persistCommittedWriteResult(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  block: Block;
  output: unknown;
}): Promise<{ block: Block; events: OrchestratorEvent[] }> {
  const content = input.block.content as {
    toolCallId?: string;
    metadata?: Record<string, unknown>;
  } | null;
  const metadata = content?.metadata ?? {};
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
  return { block: persisted.result, events: persisted.events };
}

async function completeTurn(input: {
  deps: OrchestratorDeps;
  threadId: ThreadId;
  turn: Turn;
  finishReason: GenerateResult["finishReason"];
}): Promise<{ turn: Turn; events: OrchestratorEvent[] }> {
  const completed = await persistAndAppendEvents(input.deps, input.threadId, async () => {
    const updatedTurn: Turn = {
      ...input.turn,
      status: "complete",
      finishReason: input.finishReason,
      completedAt: toIsoString(new Date()),
    };
    // updateCost is a simple increment of the turn counter; the actual cost is
    // already reflected via model.response_received and projector rollups.
    await input.deps.repos.threads.updateCost(input.threadId, "0", 1);
    return {
      result: updatedTurn,
      events: [{ type: "turn.completed", turn: updatedTurn }],
    };
  });
  return { turn: completed.result, events: completed.events };
}

async function buildGenerateRequest(input: {
  deps: OrchestratorDeps;
  runInput: RunTurnInput;
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  gatewaySignal?: AbortSignal;
}): Promise<{
  request: GenerateRequest;
  agentSlug: string | null;
  thread: Thread;
  permissionGate: PermissionGate;
}> {
  const assembled = await assembleNextTurnContext({
    thread: input.thread,
    turns: input.turns,
    blocks: input.blocks,
    agentRevisions: input.deps.agentRevisions,
    toolRegistry: input.deps.toolRegistry,
    gateway: input.deps.gateway,
    imageAssets: input.deps.imageAssets,
    baseTools: input.runInput.tools ?? input.deps.toolExecutor.getDefinitions?.(),
    persistBake: true,
    bakeComposedSystemPrompt: input.deps.repos.threads.bakeComposedSystemPrompt.bind(
      input.deps.repos.threads,
    ),
    workContext: input.deps.workContext,
  });

  return {
    thread: assembled.thread,
    agentSlug: assembled.agentSlug,
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

async function* generateEvents(
  deps: OrchestratorDeps,
  input: RunTurnInput,
  thread: Thread,
  /** The user turn whose admitted references load before the first request. */
  referenceUserTurnId: TurnId,
  assistantTurn: Turn,
  /** Full ordered history before the assistant container, including drained messages. */
  initialTurns: Turn[],
  inheritedBlocks: Block[],
  initialEvents: OrchestratorEvent[],
  treeBudget: TreeBudget,
  /**
   * Writer-activated skill slugs for this run's triggering turn. A writer start
   * carries them on its input; a drain start reads them back off the persisted
   * writer turn it serves. `undefined` when the run activated none.
   */
  activatedSkillSlugs: readonly string[] | undefined,
): AsyncGenerator<OrchestratorEvent> {
  const { gateway, repos, eventWriter } = deps;
  const eventSink = deps.eventSink;
  const turnAccounting = createTurnAccounting({ billingUsage: deps.billingUsage });

  // The loop is the only writer of the lease phase, so `authority.read` cannot
  // split-brain. Publishing is observational: a failure must not fail the turn,
  // it only leaves the phase briefly stale until the next boundary.
  async function publishPhase(phase: ThreadPhase): Promise<void> {
    const lease = input.lease;
    if (!lease) return;
    try {
      await deps.runAuthority.publish(lease, phase);
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

  yield* initialEvents;

  // Every subagent run owns a return_result completer, even when the caller did
  // not pass one (a writer sending a new message into a child chat). Writer
  // continue is settle-only: the child-run driver owns the per-run capture. A
  // primary writer turn has none, so return_result stays a failed tool_result.
  const returnResultCompleter =
    input.returnResultCompleter ??
    (thread.kind === "subagent"
      ? deps.childRunCoordinator.createReturnResultCompleter()
      : undefined);

  let currentAssistantTurn: Turn = assistantTurn;
  let activeResponseId: string | undefined;

  async function rollbackActiveResponse(): Promise<void> {
    if (!activeResponseId) return;
    const responseId = activeResponseId;
    activeResponseId = undefined;
    await deps.responseWrites.rollbackResponse(responseId, {
      threadId: input.threadId,
      turnId: currentAssistantTurn.id,
    });
  }

  // The run's single terminal exit. Every terminal route funnels through here so
  // the final claim is uniform: `closeRun` takes the per-thread lock, claims the
  // inbox once more, and either continues the run into a pending batch or runs
  // `complete` and releases the lease under the same lock. Returns true when the
  // caller must continue the loop; false when the terminal events were yielded.
  //
  // `continueOnPending` encodes the interrupt policy: true for cancel and for
  // normal completion (endTurnRequested / clean finish), where a pending message
  // becomes the next turn of the same run; false for hard error, budget cap, and
  // max-iteration, which complete and release and let the S4 wake sweep recover
  // any pending message.
  async function* exitRun(
    continueOnPending: boolean,
    complete: () => Promise<TerminalOutcome>,
  ): AsyncGenerator<OrchestratorEvent, boolean> {
    const outcome = await closeRun({
      threadLock: deps.threadLock,
      inbox: deps.inbox,
      runAuthority: deps.runAuthority,
      threadId: input.threadId,
      lease: input.lease ?? null,
      continueOnPending,
      complete,
    });
    if (outcome.kind === "continue") return true;
    currentAssistantTurn = outcome.completion.turn ?? currentAssistantTurn;
    yield* outcome.completion.events;
    return false;
  }

  const cancelTerminal = async (): Promise<TerminalOutcome> => ({
    events: await finalizeCancelled(deps, input.threadId, currentAssistantTurn),
  });
  const errorTerminal = (error: MeridianError | string) => async (): Promise<TerminalOutcome> => ({
    events: await finalizeError(deps, input.threadId, currentAssistantTurn, error),
  });
  const completeTerminal =
    (finishReason: GenerateResult["finishReason"]) => async (): Promise<TerminalOutcome> => {
      const completion = await completeTurn({
        deps,
        threadId: input.threadId,
        turn: currentAssistantTurn,
        finishReason,
      });
      return { turn: completion.turn, events: completion.events };
    };

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

  try {
    const allTurns: Turn[] = [...initialTurns, assistantTurn];
    const localBlocks: Block[] = await repos.blocks.listByThread(input.threadId);
    const allBlocks: Block[] = [...inheritedBlocks, ...localBlocks];
    let iteration = 0;
    // A successful return_result completes the turn after the current tool batch.
    let endTurnRequested = false;
    // An abort consumed by a pending-message continuation must not cancel the
    // resumed turn: the interrupt handled its boundary, the run lives on.
    let cancelConsumed = false;
    const isCancelled = () => !cancelConsumed && (input.signal?.aborted ?? false);
    // Pinned once before the first drain appends messages, so notices and skill
    // bodies attach to the writer's triggering message, never a drained message.
    let writerMessageIndex: number | undefined;
    let activatedSkillBodies:
      | Array<{ slug: string; description: string; body: string }>
      | undefined;
    const preTurnNotices: Notice[] = [];
    const postToolNoticeBatches: Array<{
      afterMessageCount: number;
      notices: Notice[];
    }> = [];
    const interruptAutoResume = await resolveInterruptAutoResumePolicy(deps, thread);

    // Every cancellation/error path must yield terminal events, not just
    // return/throw, so subscribers see the turn lifecycle closure.
    runLoop: while (true) {
      iteration += 1;
      if (iteration > MAX_TURN_ITERATIONS) {
        yield* exitRun(false, errorTerminal("exceeded max tool iterations"));
        return;
      }

      if (isCancelled()) {
        if (yield* exitRun(true, cancelTerminal)) {
          cancelConsumed = true;
          continue;
        }
        return;
      }

      const budgetError = await turnAccounting.assertPreIterationBudget(treeBudget, thread);
      if (budgetError) {
        yield* exitRun(false, errorTerminal(budgetError));
        return;
      }

      turnAccounting.recordIterationSpend(treeBudget);

      const gatewayAbort = new AbortController();
      let cancelRequested = isCancelled();
      if (input.signal && !cancelConsumed) {
        input.signal.addEventListener(
          "abort",
          () => {
            cancelRequested = true;
            gatewayAbort.abort();
          },
          { once: true },
        );
      }

      if (iteration === 1) {
        const loaded = await loadReferenceReads({
          blocks: allBlocks,
          userTurnId: referenceUserTurnId,
          threadId: input.threadId,
          assistantTurnId: currentAssistantTurn.id,
          reader: deps.referenceReader,
          signal: input.signal,
        });
        if (loaded.length > 0) {
          const persisted = await persistAndAppendEvents(deps, input.threadId, async () => ({
            result: loaded,
            events: loaded.map((block) => ({
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
            })),
          }));
          for (const block of persisted.result) {
            const index = allBlocks.findIndex((existing) => existing.id === block.id);
            allBlocks[index] = block;
          }
          yield* persisted.events;
        }
      }

      const built = await buildGenerateRequest({
        deps,
        runInput: input,
        thread,
        turns: allTurns,
        blocks: allBlocks,
        gatewaySignal: gatewayAbort.signal,
      });
      thread = built.thread;
      const request = built.request;
      const gatewayCallId = crypto.randomUUID();
      request.correlation = {
        gatewayCallId,
        threadId: input.threadId,
        turnId: currentAssistantTurn.id,
        iteration: iteration - 1,
        ...(built.agentSlug ? { agentSlug: built.agentSlug } : {}),
      };

      // The writer's triggering message is pinned before the drain appends
      // messages; notices and skill bodies must land there, not on a drained one.
      writerMessageIndex ??= lastUserMessageIndex(request.messages);
      const baseMessageCount = request.messages.length;
      let inboxAckIds: string[] = [];
      // A message is history, not transient context: the drain persists each at
      // the thread tail so later iterations of this same run keep seeing it,
      // chained from the run's own accumulated tail. The thread loaded at run
      // start is stale for an already-baked prompt (assembly does not refresh
      // it), so `thread.activeLeafTurnId` would point behind this run's own
      // setup turns and the transition would conflict.
      const drain = await drainInbox({
        persistence: deps,
        inbox: deps.inbox,
        notices: deps.notices,
        threadId: input.threadId,
        messages: request.messages,
        knownTurnIds: new Set(allTurns.map((turn) => turn.id)),
        expectedLeafTurnId: allTurns.at(-1)?.id ?? null,
        loadActivatedSkillBodies: async (turn) => {
          const slugs = readActivatedSkillSlugs(turn);
          return slugs.length > 0 ? loadSkillBodies(slugs) : [];
        },
      });
      request.messages = drain.rendered;
      inboxAckIds = drain.ackIds;
      for (const turn of drain.turns) allTurns.push(turn);
      for (const block of drain.blocks) allBlocks.push(block);
      yield* drain.persistedEvents;
      if (iteration === 1) {
        preTurnNotices.push(...drain.notices);
      } else if (drain.notices.length > 0) {
        postToolNoticeBatches.push({ afterMessageCount: baseMessageCount, notices: drain.notices });
      }

      if (activatedSkillSlugs?.length) {
        activatedSkillBodies ??= await loadSkillBodies(activatedSkillSlugs);
        request.messages = attachSkillBodiesToLatestUserMessage(
          request.messages,
          activatedSkillBodies,
          writerMessageIndex,
        );
      }
      if (preTurnNotices.length > 0) {
        request.messages = attachNoticesToLatestUserMessage(
          request.messages,
          preTurnNotices,
          writerMessageIndex,
        );
      }
      let insertedNoticeMessages = 0;
      for (const batch of postToolNoticeBatches) {
        const beforeInsert = request.messages.length;
        request.messages = insertPostToolNotices(
          request.messages,
          batch.notices,
          batch.afterMessageCount + insertedNoticeMessages,
        );
        insertedNoticeMessages += request.messages.length - beforeInsert;
      }
      // After this point the drain is durable. If the provider stream throws before
      // returning a result, the notice is lost, matching the model-call boundary.

      try {
        deps.modelRequestDebug.capture({
          gatewayCallId,
          threadId: input.threadId,
          turnId: currentAssistantTurn.id,
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
          correlation: { threadId: input.threadId, turnId: currentAssistantTurn.id },
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
      for await (const event of gateway.stream(request)) {
        if (isCancelled()) {
          cancelRequested = true;
        }

        if (event.type === "start") {
          streamModel = event.model;
        }

        const mapped = mapStreamEvent(event);
        if (mapped) {
          yield* emit(eventWriter, input.threadId, mapped);
        }

        if (event.type === "end") {
          result = event.result;
        }
        if (event.type === "error") {
          if (cancelRequested) {
            break;
          }
          yield* exitRun(
            false,
            errorTerminal(meridianErrorFromGateway(event.code, event.message, event.retryable)),
          );
          return;
        }
      }

      if (cancelRequested) {
        const settled = await settleCancelledResponse({
          deps,
          runInput: input,
          thread,
          currentAssistantTurn,
          treeBudget,
          turnAccounting,
          blockSeq: allBlocks.filter(
            (b) => (b.turnId as string) === (currentAssistantTurn.id as string),
          ).length,
          allBlocks,
          result,
          model: result?.model ?? streamModel,
        });
        yield* settled.events;
        currentAssistantTurn = settled.turn;
        if (yield* exitRun(true, cancelTerminal)) {
          cancelConsumed = true;
          continue;
        }
        return;
      }

      if (!result) {
        yield* exitRun(false, errorTerminal("Stream ended without result"));
        return;
      }

      // blockSeq is the turn-scoped display order. It starts at the blocks
      // already stored for this assistant turn and is handed to interrupt/tool
      // collaborators so later blocks remain contiguous.
      let blockSeq = allBlocks.filter(
        (b) => (b.turnId as string) === (currentAssistantTurn.id as string),
      ).length;
      const persistedResponse = await persistModelResponse({
        deps,
        runInput: input,
        thread,
        currentAssistantTurn,
        result,
        treeBudget,
        turnAccounting,
        blockSeq,
        inboxAckIds,
      });
      currentAssistantTurn = persistedResponse.updatedTurn;
      blockSeq = persistedResponse.nextBlockSeq;
      const responseId = persistedResponse.responseId;
      const toolCallsFromResult = persistedResponse.toolCalls;
      allBlocks.push(...persistedResponse.createdBlocks);
      yield* persistedResponse.events;

      if (result.finishReason === "error") {
        yield* exitRun(false, errorTerminal("Model returned error finish reason"));
        return;
      }

      // blockSeq continues across tool_result blocks so all blocks for this
      // turn are numbered contiguously regardless of which iteration
      // created them.
      if (result.finishReason === "tool_use" && toolCallsFromResult.length > 0) {
        activeResponseId = responseId;
        if (isCancelled()) {
          await rollbackActiveResponse();
          if (yield* exitRun(true, cancelTerminal)) {
            cancelConsumed = true;
            continue;
          }
          return;
        }

        const writeBlocksByDocument = new Map<
          string,
          Array<{ block: Block; writeId: string; settlementId: string }>
        >();
        let editResponseId = responseId;

        async function settleWriteScope() {
          const finalizedWrites: Array<{
            documentId: string;
            index: number;
            block: Block;
            events: OrchestratorEvent[];
          }> = [];
          const outcome = await deps.responseWrites.commitResponse(
            editResponseId,
            { threadId: input.threadId, turnId: currentAssistantTurn.id },
            async (settled) => {
              for (const [documentId, blocks] of writeBlocksByDocument) {
                for (const [index, write] of blocks.entries()) {
                  const finalized =
                    settled.status === "committed"
                      ? await persistCommittedWriteResult({
                          deps,
                          threadId: input.threadId,
                          block: write.block,
                          output: settledReceipt(settled.receipts, documentId, write.settlementId)
                            .result,
                        })
                      : await persistUncommittedWriteResult({
                          deps,
                          threadId: input.threadId,
                          block: write.block,
                          text: "The response closed before its staged write could commit. Re-read and retry.",
                        });
                  finalizedWrites.push({ documentId, index, ...finalized });
                }
              }
            },
          );
          const events: OrchestratorEvent[] = [];
          for (const finalized of finalizedWrites) {
            const writes = writeBlocksByDocument.get(finalized.documentId);
            const write = writes?.[finalized.index];
            if (writes && write) writes[finalized.index] = { ...write, block: finalized.block };
            const blockIndex = allBlocks.findIndex(
              (existing) => existing.id === finalized.block.id,
            );
            if (blockIndex >= 0) allBlocks[blockIndex] = finalized.block;
            events.push(...finalized.events);
          }
          return { outcome, events };
        }

        // Sequential dispatch is load-bearing: agent writes resolve against the runtime doc one
        // at a time, so overlapping self-writes compose or no_match instead of self-mangling.
        for (const call of toolCallsFromResult) {
          if (isCancelled()) {
            await rollbackActiveResponse();
            if (yield* exitRun(true, cancelTerminal)) {
              cancelConsumed = true;
              continue runLoop;
            }
            return;
          }

          if (
            call.name === "work" &&
            call.arguments &&
            typeof call.arguments === "object" &&
            "command" in call.arguments &&
            call.arguments.command === "switch" &&
            writeBlocksByDocument.size > 0
          ) {
            const boundary = await settleWriteScope();
            activeResponseId = undefined;
            yield* boundary.events;
            if (boundary.outcome.status === "draft_closed") {
              if (yield* exitRun(true, cancelTerminal)) {
                cancelConsumed = true;
                continue runLoop;
              }
              return;
            }
            writeBlocksByDocument.clear();
            // A closed response fingerprint cannot accept post-switch writes.
            // Rotate only the agent-edit lifecycle identity; durable tool blocks
            // remain attached to the provider's model response.
            editResponseId = crypto.randomUUID();
            activeResponseId = editResponseId;
          }

          // If denied, we still persist a tool_result block (with isError: true)
          // so the model sees the rejection in the next turn's context build.
          const decision = built.permissionGate.check(call.name, call.arguments);
          if (!decision.allowed) {
            const persistedDenial = await persistPermissionDenial({
              deps,
              threadId: input.threadId,
              turn: currentAssistantTurn,
              call,
              decision: { ...decision, category: "tool_denied" },
              blockSeq,
            });
            blockSeq = persistedDenial.nextBlockSeq;
            allBlocks.push(persistedDenial.block);
            yield* persistedDenial.events;
            continue;
          }

          await publishPhase("waiting");
          const interruptState = {
            thread,
            threadId: input.threadId,
            currentTurn: currentAssistantTurn,
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
              workContextDelivery: deps.workContextDelivery,
            },
            call,
            {
              thread,
              agentSlug: built.agentSlug,
              responseId,
              editResponseId,
              state: interruptState,
              interruptSession,
              interruptAutoResume,
              treeBudget,
              blockSeqRef: interruptState.blockSeqRef,
              returnResultCompleter,
              allTurns,
            },
          );
          currentAssistantTurn = interruptState.currentTurn;
          blockSeq = interruptState.blockSeqRef.value;
          yield* dispatched.events;
          if (
            !dispatched.cancelled &&
            dispatched.metadata?.stagedWrite === true &&
            typeof dispatched.metadata.documentId === "string"
          ) {
            if (typeof dispatched.metadata.writeId !== "string") {
              throw new Error(
                `Staged write result missing write id for ${dispatched.metadata.documentId}.`,
              );
            }
            if (typeof dispatched.metadata.settlementId !== "string") {
              throw new Error(
                `Staged write result missing settlement id for ${dispatched.metadata.documentId}.`,
              );
            }
            const blocks = writeBlocksByDocument.get(dispatched.metadata.documentId) ?? [];
            blocks.push({
              block: dispatched.block,
              writeId: dispatched.metadata.writeId,
              settlementId: dispatched.metadata.settlementId,
            });
            writeBlocksByDocument.set(dispatched.metadata.documentId, blocks);
          }
          if (dispatched.cancelled || isCancelled()) {
            await rollbackActiveResponse();
            if (yield* exitRun(true, cancelTerminal)) {
              cancelConsumed = true;
              continue runLoop;
            }
            return;
          }
          if (dispatched.endTurn === true) endTurnRequested = true;
        }
        if (isCancelled()) {
          await rollbackActiveResponse();
          if (yield* exitRun(true, cancelTerminal)) {
            cancelConsumed = true;
            continue;
          }
          return;
        }
        const settledScope = await settleWriteScope();
        const concurrentEdits = settledScope.outcome;
        activeResponseId = undefined;
        yield* settledScope.events;
        if (concurrentEdits.status === "draft_closed") {
          if (yield* exitRun(true, cancelTerminal)) {
            cancelConsumed = true;
            continue;
          }
          return;
        }

        const renderBudget = {
          remainingBytes: deps.concurrentRenderBudgetBytes?.(request) ?? Number.MAX_SAFE_INTEGER,
        };
        // Backfill body-complete concurrent runs into the last write result per document.
        for (const { documentId, concurrentEdits: edits } of concurrentEdits.concurrentEdits) {
          const boundedEdits = applyConcurrentRenderBudget(edits, renderBudget);
          const block = writeBlocksByDocument.get(documentId)?.at(-1)?.block;
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
          const persistedBackfill = await persistAndAppendEvents(
            deps,
            input.threadId,
            async () => ({
              result: localBlockFromEvent(updatedBlockRow),
              events: [{ type: "block.upserted", block: updatedBlockRow }],
            }),
          );
          const blockIndex = allBlocks.findIndex((existing) => existing.id === block.id);
          if (blockIndex >= 0) allBlocks[blockIndex] = persistedBackfill.result;
          const documentBlocks = writeBlocksByDocument.get(documentId) ?? [];
          const lastWrite = documentBlocks.at(-1);
          if (lastWrite) {
            documentBlocks[documentBlocks.length - 1] = {
              ...lastWrite,
              block: persistedBackfill.result,
            };
          }
          yield* persistedBackfill.events;
        }

        if (endTurnRequested) {
          // A child called return_result: the report is captured and persisted,
          // so the turn ends here instead of looping into another model round.
          // A message that landed in the exit window keeps the run going.
          if (yield* exitRun(true, completeTerminal("end_turn"))) continue;
          return;
        }

        continue;
      }

      if (yield* exitRun(true, completeTerminal(result.finishReason))) continue;
      return;
    }
  } catch (err) {
    try {
      await rollbackActiveResponse();
    } catch (_rollbackError) {
      // Keep the original turn failure visible. rollbackResponse invalidates
      // staged runtimes before surfacing cleanup failures, so a second failure
      // here should not hide the error that broke the response.
    }
    yield* await finalizeTurnOnGeneratorFailure(deps, {
      threadId: input.threadId,
      assistantTurnId: currentAssistantTurn.id,
      error: err,
      signal: input.signal,
    });
  } finally {
    await rollbackActiveResponse().catch(() => undefined);
    // Helper result delivery is flushed by callers after their live-turn registry
    // is cleared. Draining here would race queued helper system turns into a
    // still-running parent thread.
  }
}
