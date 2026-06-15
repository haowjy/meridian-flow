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

import { meridianErrorFromGateway, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
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
import type { CreditLedger } from "../../billing/index.js";
import type { EventSink } from "../../observability/index.js";
import type { PackageRepository } from "../../packages/index.js";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type {
  BlockRepository,
  EventJournalWriter,
  ModelResponseRepository,
  ThreadRepository,
  TurnRepository,
} from "../../threads/index.js";
import { readOpenRouterGenerationId } from "../gateway/adapters/openrouter/provider-data.js";
import type { GenerateRequest, GenerateResult, Gateway as LlmGateway } from "../gateway/index.js";
import type { ModelRequestDebugStore } from "../model-request-debug/index.js";
import { buildModelRequestDebugRecord } from "../model-request-debug/index.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import type { HelperResultDelivery } from "../spawn/helper-result-delivery.js";
import type { ToolExecutor, ToolRegistry } from "../tools/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import {
  buildReconciliationStub,
  createReconcileSignal,
  type OpenRouterReconcileConfig,
  reconcileInterruptedModelResult,
  shouldPersistCancelledModelCall,
} from "./cancel-settlement.js";
import { type CheckpointArtifactFlushPort, createCheckpointSession } from "./checkpoint-session.js";
import {
  type CheckpointAutoResumePolicy,
  type CheckpointRegistry,
  defaultCheckpointAutoResumePolicy,
} from "./checkpoints.js";
import { finalizeCancelled, finalizeError } from "./finalization.js";
import { loadThreadConversationContext } from "./fork-thread-context.js";
import type { PermissionGate } from "./permissions/index.js";
import { appendEvent, persistAndAppendEvents } from "./persistence.js";
import type { RunTurnHandle, RunTurnInput, RunTurnPort } from "./run-turn-port.js";
import {
  collectToolCalls,
  contentPartToBlockInput,
  mapStreamEvent,
  toJsonValue,
} from "./streaming.js";
import { dispatchToolCall } from "./tool-dispatch.js";
import { createTurnAccounting, type TurnAccounting } from "./turn-accounting.js";
import { assembleNextTurnContext } from "./turn-context-assembly.js";

// ── Safety valve ──
// Prevents infinite tool-calling loops (e.g. a model that always returns
// tool_use). After 32 iterations the turn is finalized with an error.
const MAX_TURN_ITERATIONS = 32;

export interface OrchestratorRepositories {
  threads: ThreadRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

export interface OrchestratorDeps {
  gateway: LlmGateway;
  toolExecutor: ToolExecutor;
  repos: OrchestratorRepositories;
  eventWriter: EventJournalWriter;
  packageRepository: PackageRepository;
  toolRegistry: ToolRegistry;
  projectPreferences: {
    read(userId: string, projectId: string): Promise<ProjectPreferences>;
  };
  permissionGate: PermissionGate;
  /** Project-scoped ledger for model-call credit balance checks, debits, and spawn rollups. */
  creditLedger: CreditLedger;
  /** Checkpoint-boundary artifact flush; explicit noop adapter means disabled. */
  checkpointArtifacts: CheckpointArtifactFlushPort;
  childRunCoordinator: ChildRunCoordinator;
  helperResultDelivery?: HelperResultDelivery;
  checkpointRegistry: CheckpointRegistry;
  eventSink: EventSink;
  modelRequestDebug: ModelRequestDebugStore;
  /** OpenRouter /generation reconciliation for interrupted turns without stream usage. */
  openRouterReconcile?: OpenRouterReconcileConfig;
}

export function createOrchestrator(deps: OrchestratorDeps): RunTurnPort {
  return {
    runTurn(input: RunTurnInput): Promise<RunTurnHandle> {
      return runTurn(deps, input);
    },
  };
}

// ── Cost/token arithmetic helpers ──
// USD rollups are display-side estimates only; the authoritative ledger truth
// is integer millicredits. Keep these strings stable for UI snapshots, but do
// not use them for billing decisions.
function addCostUsd(a: string, b: string): string {
  return (Number(a) + Number(b)).toFixed(6);
}

// Accumulates an optional integer token count; treats null as "not-yet-known"
// (preserving null) while coalescing undefined to 0 so missing deltas don't
// corrupt the running sum.
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

// ── Turn snapshot update ──
// Returns a new Turn object with token/cost fields incremented from one
// model response. This is an immutable-update pattern: the caller replaces
// `currentAssistantTurn` with the returned snapshot after each model call
// so the next context build sees the updated rollup.
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

async function resolveCheckpointAutoResumePolicy(
  deps: OrchestratorDeps,
  thread: Thread,
): Promise<CheckpointAutoResumePolicy> {
  const preferences = await deps.projectPreferences.read(thread.userId, thread.projectId);
  return preferences.autoResume ?? defaultCheckpointAutoResumePolicy();
}

// ── Initial usage accumulator ──
// Every turn starts with zero-cost / zero-token usage. The usage object is
// non-nullable in local state so the snapshot builder always has a valid
// `TurnUsage` to display, even before the first model response arrives.
function emptyTurnUsage(): NonNullable<Turn["usage"]> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    totalMillicredits: "0",
    responseCount: 0,
  };
}

// ── In-memory turn factory ──
// Mints a Turn object with a UUID before persistence. Used for both the
// user turn (status: "complete", immediately final) and the assistant turn
// (status: "streaming", updated in-place as the loop progresses).
// The `parentTurnId` is set to `prevTurnId` for now — this is the simple
// linear chain model; spawn/fork parentage will diverge when sub-agents land.
function createLocalTurn(input: {
  threadId: ThreadId;
  prevTurnId: TurnId | null;
  role: Turn["role"];
  status: Turn["status"];
}): Turn {
  return {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    prevTurnId: input.prevTurnId,
    parentTurnId: input.prevTurnId,
    role: input.role,
    status: input.status,
    finishReason: null,
    model: null,
    provider: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: "0",
    totalMillicredits: "0",
    responseCount: 0,
    usage: emptyTurnUsage(),
    error: null,
    requestParams: null,
    responseMetadata: null,
    createdAt: toIsoString(new Date()),
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

// ── Emit helper ──
// Appends one event to the durable journal and yields it. Used for
// non-transactional events (stream.delta, tool.executing) that don't need
// read-model projection — they are ephemeral transport facts, not durable
// authority.
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

  const balance = BigInt(
    await deps.creditLedger.getBalance({
      userId: thread.userId,
      projectId: thread.projectId,
    }),
  );
  if (balance < 0n) {
    throw meridianErrorFromSystem(
      "credits_exhausted",
      "Project credits are exhausted; add credits before starting a new turn",
    );
  }

  const priorTurns = await repos.turns.listByThread(input.threadId);
  const conversation = await loadThreadConversationContext(
    { threads: repos.threads, turns: repos.turns, blocks: repos.blocks },
    thread,
  );
  const inheritedTurnCount = Math.max(0, conversation.turns.length - priorTurns.length);
  const inheritedTurns = conversation.turns.slice(0, inheritedTurnCount);
  const inheritedTurnIds = new Set(inheritedTurns.map((turn) => turn.id));
  const inheritedBlocks = conversation.blocks.filter((block) => inheritedTurnIds.has(block.turnId));
  const lastTurn = priorTurns.at(-1) ?? inheritedTurns.at(-1) ?? null;

  // The setup transaction mints both turns + the user text block.
  // The read-model projector creates turn/block rows from the emitted events.
  const setup = await persistAndAppendEvents(deps, input.threadId, async () => {
    const userTurn = createLocalTurn({
      threadId: input.threadId,
      prevTurnId: lastTurn?.id ?? null,
      role: "user",
      status: "complete",
    });
    const userBlock = contentForBlockInput({
      turnId: userTurn.id,
      blockType: "text",
      sequence: 0,
      textContent: input.userText,
      status: "complete",
    });

    const assistantTurn = createLocalTurn({
      threadId: input.threadId,
      prevTurnId: userTurn.id,
      role: "assistant",
      status: "streaming",
    });
    await repos.threads.updateStatus(input.threadId, "active");

    return {
      result: { userTurn, assistantTurn },
      events: [
        { type: "turn.created", turn: userTurn },
        { type: "block.upserted", block: userBlock },
        { type: "turn.created", turn: assistantTurn },
      ],
    };
  });

  const { userTurn, assistantTurn } = setup.result;

  return {
    userTurnId: userTurn.id,
    assistantTurnId: assistantTurn.id,
    events: generateEvents(
      deps,
      input,
      thread,
      userTurn,
      assistantTurn,
      priorTurns,
      inheritedTurns,
      inheritedBlocks,
      setup.events,
      input.treeBudget ?? createDefaultTreeBudget(),
    ),
  };
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
}): Promise<{
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
      providerRequestId: readOpenRouterGenerationId(result.providerData) ?? null,
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

    return {
      result: { updatedTurn, createdBlocks },
      events,
    };
  });

  return {
    updatedTurn: persistedResponse.result.updatedTurn,
    createdBlocks: persistedResponse.result.createdBlocks,
    toolCalls,
    nextBlockSeq: blockSeq,
    events: persistedResponse.events,
  };
}

async function* settleAndFinalizeCancelled(input: {
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
  provider: string;
  generationId?: string;
}): AsyncGenerator<OrchestratorEvent> {
  let currentAssistantTurn = input.currentAssistantTurn;
  let blockSeq = input.blockSeq;
  let settleResult = input.result;
  if (!settleResult && input.generationId) {
    settleResult = buildReconciliationStub({
      model: input.model,
      provider: input.provider,
      generationId: input.generationId,
    });
  }

  if (settleResult && shouldPersistCancelledModelCall(settleResult)) {
    const reconcileSignal = createReconcileSignal();
    settleResult = await reconcileInterruptedModelResult(
      input.deps.openRouterReconcile,
      settleResult,
      reconcileSignal,
    );
    const persistedResponse = await persistModelResponse({
      deps: input.deps,
      runInput: input.runInput,
      thread: input.thread,
      currentAssistantTurn,
      result: settleResult,
      treeBudget: input.treeBudget,
      turnAccounting: input.turnAccounting,
      blockSeq,
    });
    currentAssistantTurn = persistedResponse.updatedTurn;
    blockSeq = persistedResponse.nextBlockSeq;
    input.allBlocks.push(...persistedResponse.createdBlocks);
    yield* persistedResponse.events;
  }

  yield* await finalizeCancelled(input.deps, input.runInput.threadId, currentAssistantTurn);
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
    await input.deps.repos.threads.updateStatus(input.threadId, "idle");
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
  thread: Thread;
  resolvedSkills: Awaited<ReturnType<typeof assembleNextTurnContext>>["resolvedSkills"];
}> {
  const assembled = await assembleNextTurnContext({
    thread: input.thread,
    turns: input.turns,
    blocks: input.blocks,
    packageRepository: input.deps.packageRepository,
    toolRegistry: input.deps.toolRegistry,
    baseTools: input.runInput.tools ?? input.deps.toolExecutor.getDefinitions?.(),
    persistBake: true,
    bakeComposedSystemPrompt: input.deps.repos.threads.bakeComposedSystemPrompt.bind(
      input.deps.repos.threads,
    ),
  });

  return {
    thread: assembled.thread,
    resolvedSkills: assembled.resolvedSkills,
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
  userTurn: Turn,
  assistantTurn: Turn,
  priorTurns: Turn[],
  inheritedTurns: Turn[],
  inheritedBlocks: Block[],
  initialEvents: OrchestratorEvent[],
  treeBudget: TreeBudget,
): AsyncGenerator<OrchestratorEvent> {
  const { gateway, repos, eventWriter } = deps;
  const eventSink = deps.eventSink;
  const turnAccounting = createTurnAccounting({ creditLedger: deps.creditLedger });

  yield* initialEvents;

  // Local state: accumulate turns + blocks to avoid re-reading the entire
  // thread from the DB on every tool-loop iteration.
  const allTurns: Turn[] = [...inheritedTurns, ...priorTurns, userTurn, assistantTurn];
  const localBlocks: Block[] = await repos.blocks.listByThread(input.threadId);
  const allBlocks: Block[] = [...inheritedBlocks, ...localBlocks];
  let currentAssistantTurn: Turn = assistantTurn;
  let iteration = 0;
  const checkpointAutoResume = await resolveCheckpointAutoResumePolicy(deps, thread);

  // ── Agentic turn loop ──
  // Each iteration: build context → stream model → persist response +
  // blocks → optionally execute tools → repeat or finalize.
  // Every cancellation/error path must yield terminal events, not just
  // return/throw, so subscribers see the turn lifecycle closure.
  try {
    while (true) {
      iteration += 1;
      if (iteration > MAX_TURN_ITERATIONS) {
        yield* await finalizeError(
          deps,
          input.threadId,
          currentAssistantTurn,
          "exceeded max tool iterations",
        );
        return;
      }

      // Check cancellation before every expensive operation.
      if (input.signal?.aborted) {
        yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
        return;
      }

      const budgetError = await turnAccounting.assertPreIterationBudget(treeBudget, thread);
      if (budgetError) {
        yield* await finalizeError(deps, input.threadId, currentAssistantTurn, budgetError);
        return;
      }

      turnAccounting.recordIterationSpend(treeBudget);

      const gatewayAbort = new AbortController();
      let cancelRequested = input.signal?.aborted ?? false;
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

      deps.modelRequestDebug.record(
        buildModelRequestDebugRecord({
          threadId: input.threadId,
          turnId: currentAssistantTurn.id,
          iteration: iteration - 1,
          agentSlug: thread.currentAgent,
          request,
          resolvedSkills: built.resolvedSkills,
          toolRegistry: deps.toolRegistry,
        }),
      );

      // ── Gateway stream consumption ──
      // The gateway yields a self-terminating stream: a sequence of
      // text/reasoning/tool_call deltas followed by exactly one 'end'
      // (with the assembled GenerateResult) or one 'error'.
      // On cancel, abort the gateway call and drain through 'end' so partial
      // usage can be persisted before turn.cancelled.
      let result: GenerateResult | undefined;
      let streamModel = request.model ?? "unknown";
      let streamProvider = request.provider ?? "unknown";
      for await (const event of gateway.stream(request)) {
        if (input.signal?.aborted) {
          cancelRequested = true;
        }

        if (event.type === "start") {
          streamModel = event.model;
          streamProvider = event.provider;
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
          yield* await finalizeError(
            deps,
            input.threadId,
            currentAssistantTurn,
            meridianErrorFromGateway(event.code, event.message, event.retryable),
          );
          return;
        }
      }

      if (cancelRequested) {
        yield* settleAndFinalizeCancelled({
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
          provider: result?.provider ?? streamProvider,
          generationId: result ? readOpenRouterGenerationId(result.providerData) : undefined,
        });
        return;
      }

      if (!result) {
        yield* await finalizeError(
          deps,
          input.threadId,
          currentAssistantTurn,
          "Stream ended without result",
        );
        return;
      }

      // ── Persist model response + content blocks ──
      // blockSeq is the turn-scoped display order. It starts at the blocks
      // already stored for this assistant turn and is handed to checkpoint/tool
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
      });
      currentAssistantTurn = persistedResponse.updatedTurn;
      blockSeq = persistedResponse.nextBlockSeq;
      const toolCallsFromResult = persistedResponse.toolCalls;
      allBlocks.push(...persistedResponse.createdBlocks);
      yield* persistedResponse.events;

      if (result.finishReason === "error") {
        yield* await finalizeError(
          deps,
          input.threadId,
          currentAssistantTurn,
          "Model returned error finish reason",
        );
        return;
      }

      // ── Tool execution loop ──
      // Each tool call is checked against the PermissionGate, executed,
      // and its result persisted as a tool_result block. Denied calls get a
      // synthetic error tool_result so the model sees a clean rejection.
      // blockSeq continues across tool_result blocks so all blocks for this
      // turn are numbered contiguously regardless of which iteration
      // created them.
      if (result.finishReason === "tool_use" && toolCallsFromResult.length > 0) {
        if (input.signal?.aborted) {
          yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
          return;
        }

        for (const call of toolCallsFromResult) {
          if (input.signal?.aborted) {
            yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
            return;
          }

          // Permission check: tool allow/deny list + cost cap.
          // If denied, we still persist a tool_result block (with isError: true)
          // so the model sees the rejection in the next turn's context build.
          const decision = deps.permissionGate.check(
            call.name,
            Number(currentAssistantTurn.totalCostUsd),
          );
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

          const checkpointState = {
            thread,
            threadId: input.threadId,
            currentTurn: currentAssistantTurn,
            autoResume: checkpointAutoResume,
            signal: input.signal,
            blockSeqRef: { value: blockSeq },
            allBlocks,
          };
          const checkpointSession = createCheckpointSession(
            {
              checkpointRegistry: deps.checkpointRegistry,
              checkpointArtifacts: deps.checkpointArtifacts,
              persistenceDeps: deps,
              eventSink,
            },
            checkpointState,
          );
          const dispatched = await dispatchToolCall(
            {
              toolExecutor: deps.toolExecutor,
              childRunCoordinator: deps.childRunCoordinator,
              eventSink,
              persistenceDeps: deps,
            },
            call,
            {
              thread,
              state: checkpointState,
              checkpointSession,
              checkpointAutoResume,
              treeBudget,
              blockSeqRef: checkpointState.blockSeqRef,
              returnResultCompleter: input.returnResultCompleter,
            },
          );
          currentAssistantTurn = checkpointState.currentTurn;
          blockSeq = checkpointState.blockSeqRef.value;
          yield* dispatched.events;
        }
        // After all tool results are persisted, loop back to build context
        // with the updated blocks and make the next model call.
        continue;
      }

      // ── Turn completion ──
      // Non-tool finish reasons (end_turn, stop_sequence, max_tokens).
      const completed = await completeTurn({
        deps,
        threadId: input.threadId,
        turn: currentAssistantTurn,
        finishReason: result.finishReason,
      });
      currentAssistantTurn = completed.turn;
      yield* completed.events;
      return;
    }
  } catch (err) {
    // Unexpected exception (e.g. DB failure, tool crash). If the signal is
    // already aborted, treat as cancellation; otherwise finalize as error.
    // We re-throw after yielding events so the caller (turn-runner) can log.
    if (input.signal?.aborted) {
      yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    yield* await finalizeError(deps, input.threadId, currentAssistantTurn, message);
    throw err;
  } finally {
    // Helper result delivery is flushed by callers after their live-turn registry
    // is cleared. Draining here would race queued helper system turns into a
    // still-running parent thread.
  }
}
