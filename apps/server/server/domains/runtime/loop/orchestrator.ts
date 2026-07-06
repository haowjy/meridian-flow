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

import type { ConcurrentEditInfo } from "@meridian/agent-edit";
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
import type { BillingUsagePolicy } from "../../billing/index.js";
import type { DraftLifecycleState } from "../../collab/domain/branch-review.js";
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
import type {
  PendingUndoNotification,
  PendingUndoNotificationRepository,
} from "../../undo-notifications/index.js";
import type { GenerateRequest, GenerateResult, Gateway as LlmGateway } from "../gateway/index.js";
import type { ModelRequestDebugStore } from "../model-request-debug/index.js";
import { buildModelRequestDebugRecord } from "../model-request-debug/index.js";
import type { ChildRunCoordinator } from "../spawn/child-run-coordinator.js";
import type { HelperResultDelivery } from "../spawn/helper-result-delivery.js";
import type { ToolExecutor, ToolRegistry } from "../tools/index.js";
import { contentForBlockInput, localBlockFromEvent } from "./block-helpers.js";
import { undoNotificationSystemMessage } from "./context-builder.js";
import {
  finalizeCancelled,
  finalizeError,
  finalizeTurnOnGeneratorFailure,
} from "./finalization.js";
import { loadThreadConversationContext } from "./fork-thread-context.js";
import { createInterruptSession, type InterruptArtifactFlushPort } from "./interrupt-session.js";
import {
  defaultInterruptAutoResumePolicy,
  type InterruptAutoResumePolicy,
  type InterruptRegistry,
} from "./interrupts.js";
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
  billingUsage: BillingUsagePolicy;
  /** Interrupt-boundary artifact flush; explicit noop adapter means disabled. */
  interruptArtifacts: InterruptArtifactFlushPort;
  childRunCoordinator: ChildRunCoordinator;
  helperResultDelivery?: HelperResultDelivery;
  interruptRegistry: InterruptRegistry;
  eventSink: EventSink;
  modelRequestDebug: ModelRequestDebugStore;
  undoNotifications: PendingUndoNotificationRepository;
  draftLifecycleStates?: {
    listByWork(input: { workId: string }): Promise<DraftLifecycleState[]>;
  };
  responseWrites: {
    commitResponse(
      responseId: string,
      ctx: { threadId: ThreadId; turnId: TurnId },
    ): Promise<
      | {
          status: "committed";
          concurrentEdits: { documentId: string; concurrentEdits: ConcurrentEditInfo }[];
        }
      | { status: "draft_closed"; responseId: string; mode: "draft" }
    >;
    rollbackResponse(responseId: string): Promise<void>;
  };
}

function isTextContentBlockArray(value: unknown): value is Array<{ type: "text"; text: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
  );
}

function formatConcurrentEdits(info: ConcurrentEditInfo): string {
  const lines = ["concurrent edits:"];
  if (info.human.length > 0) lines.push(`  human: ${info.human.join(", ")}`);
  if (info.agent.length > 0) lines.push(`  agent: ${info.agent.join(", ")}`);
  if (info.renderedBlocks) {
    lines.push("current blocks:");
    if (info.renderedBlocks.human.length > 0) {
      lines.push("  human:", ...info.renderedBlocks.human.map((line) => `    ${line}`));
    }
    if (info.renderedBlocks.agent.length > 0) {
      lines.push("  agent:", ...info.renderedBlocks.agent.map((line) => `    ${line}`));
    }
  }
  if (info.reviewCommand) lines.push(info.reviewCommand);
  return lines.join("\n");
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

async function resolveInterruptAutoResumePolicy(
  deps: OrchestratorDeps,
  thread: Thread,
): Promise<InterruptAutoResumePolicy> {
  const preferences = await deps.projectPreferences.read(thread.userId, thread.projectId);
  return preferences.autoResume ?? defaultInterruptAutoResumePolicy();
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

  // New turns require positive balance; the mid-stream gate in turn-accounting
  // allows zero grace only after an already-started turn is in flight.
  if (!(await deps.billingUsage.canStartTurn(thread.userId))) {
    throw meridianErrorFromSystem(
      "credits_exhausted",
      "Your usage balance is exhausted; add balance before starting a new turn",
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
  const draftLifecycleStates = await loadDraftLifecycleStates(deps, thread);

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
      draftLifecycleStates,
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
}): AsyncGenerator<OrchestratorEvent> {
  let currentAssistantTurn = input.currentAssistantTurn;
  let blockSeq = input.blockSeq;
  const settlement = await input.deps.gateway.settleCancelledResult?.({
    model: input.model,
    ...(input.result ? { result: input.result } : {}),
    ...(input.result?.providerRequestId
      ? { providerRequestId: input.result.providerRequestId }
      : {}),
  });

  if (settlement?.persist) {
    const persistedResponse = await persistModelResponse({
      deps: input.deps,
      runInput: input.runInput,
      thread: input.thread,
      currentAssistantTurn,
      result: settlement.result,
      treeBudget: input.treeBudget,
      turnAccounting: input.turnAccounting,
      blockSeq,
    });
    currentAssistantTurn = persistedResponse.updatedTurn;
    blockSeq = persistedResponse.nextBlockSeq;
    input.allBlocks.push(...persistedResponse.createdBlocks);
    yield* persistedResponse.events;
    await input.deps.responseWrites.rollbackResponse(persistedResponse.responseId);
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

async function loadDraftLifecycleStates(
  deps: OrchestratorDeps,
  thread: Thread,
): Promise<DraftLifecycleState[]> {
  if (!deps.draftLifecycleStates || !thread.workId) return [];
  return deps.draftLifecycleStates.listByWork({ workId: thread.workId });
}

async function buildGenerateRequest(input: {
  deps: OrchestratorDeps;
  runInput: RunTurnInput;
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  gatewaySignal?: AbortSignal;
  undoNotifications?: readonly PendingUndoNotification[];
  draftLifecycleStates?: readonly DraftLifecycleState[];
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
    undoNotifications: input.undoNotifications,
    draftLifecycleStates: input.draftLifecycleStates,
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
  draftLifecycleStates: readonly DraftLifecycleState[],
): AsyncGenerator<OrchestratorEvent> {
  const { gateway, repos, eventWriter } = deps;
  const eventSink = deps.eventSink;
  const turnAccounting = createTurnAccounting({ billingUsage: deps.billingUsage });

  yield* initialEvents;

  // Local state: accumulate turns + blocks to avoid re-reading the entire
  // thread from the DB on every tool-loop iteration.
  let currentAssistantTurn: Turn = assistantTurn;
  let activeResponseId: string | undefined;

  async function rollbackActiveResponse(): Promise<void> {
    if (!activeResponseId) return;
    const responseId = activeResponseId;
    activeResponseId = undefined;
    await deps.responseWrites.rollbackResponse(responseId);
  }

  try {
    const allTurns: Turn[] = [...inheritedTurns, ...priorTurns, userTurn, assistantTurn];
    const localBlocks: Block[] = await repos.blocks.listByThread(input.threadId);
    const allBlocks: Block[] = [...inheritedBlocks, ...localBlocks];
    let iteration = 0;
    let shouldInjectUndoNotifications = true;
    const interruptAutoResume = await resolveInterruptAutoResumePolicy(deps, thread);

    // ── Agentic turn loop ──
    // Each iteration: build context → stream model → persist response +
    // blocks → optionally execute tools → repeat or finalize.
    // Every cancellation/error path must yield terminal events, not just
    // return/throw, so subscribers see the turn lifecycle closure.
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
        draftLifecycleStates,
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

      if (shouldInjectUndoNotifications) {
        const undoNotifications = await deps.undoNotifications.consumeForThread(input.threadId);
        shouldInjectUndoNotifications = false;
        if (undoNotifications.length > 0) {
          const insertAt = request.messages.findIndex((message) => message.role !== "system");
          request.messages.splice(
            insertAt === -1 ? request.messages.length : insertAt,
            0,
            undoNotificationSystemMessage(undoNotifications),
          );
        }
        // After this point the consume is durable. If the provider stream throws before
        // returning a result, the notification is lost, matching the model-call boundary.
      }

      // ── Gateway stream consumption ──
      // The gateway yields a self-terminating stream: a sequence of
      // text/reasoning/tool_call deltas followed by exactly one 'end'
      // (with the assembled GenerateResult) or one 'error'.
      // On cancel, abort the gateway call and drain through 'end' so partial
      // usage can be persisted before turn.cancelled.
      let result: GenerateResult | undefined;
      let streamModel = request.model ?? "unknown";
      for await (const event of gateway.stream(request)) {
        if (input.signal?.aborted) {
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
      });
      currentAssistantTurn = persistedResponse.updatedTurn;
      blockSeq = persistedResponse.nextBlockSeq;
      const responseId = persistedResponse.responseId;
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
        activeResponseId = responseId;
        if (input.signal?.aborted) {
          await rollbackActiveResponse();
          yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
          return;
        }

        const writeBlocksByDocument = new Map<string, Block>();

        // Sequential dispatch is load-bearing: agent writes resolve against the runtime doc one
        // at a time, so overlapping self-writes compose or no_match instead of self-mangling.
        for (const call of toolCallsFromResult) {
          if (input.signal?.aborted) {
            await rollbackActiveResponse();
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
            },
            call,
            {
              thread,
              responseId,
              state: interruptState,
              interruptSession,
              interruptAutoResume,
              treeBudget,
              blockSeqRef: interruptState.blockSeqRef,
              returnResultCompleter: input.returnResultCompleter,
            },
          );
          currentAssistantTurn = interruptState.currentTurn;
          blockSeq = interruptState.blockSeqRef.value;
          yield* dispatched.events;
          if (!dispatched.cancelled && typeof dispatched.metadata?.documentId === "string") {
            writeBlocksByDocument.set(dispatched.metadata.documentId, dispatched.block);
          }
          if (dispatched.cancelled || input.signal?.aborted) {
            await rollbackActiveResponse();
            yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
            return;
          }
        }
        if (input.signal?.aborted) {
          await rollbackActiveResponse();
          yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
          return;
        }
        const concurrentEdits = await deps.responseWrites.commitResponse(responseId, {
          threadId: input.threadId,
          turnId: currentAssistantTurn.id,
        });
        activeResponseId = undefined;
        if (concurrentEdits.status === "draft_closed") {
          yield* await finalizeCancelled(deps, input.threadId, currentAssistantTurn);
          return;
        }

        // Backfill concurrent edit info into the last write tool_result block per document.
        for (const { documentId, concurrentEdits: edits } of concurrentEdits.concurrentEdits) {
          const block = writeBlocksByDocument.get(documentId);
          if (!block) continue;
          const content = block.content as {
            toolCallId?: string;
            output?: unknown;
            isError?: boolean;
          } | null;
          if (!content?.output) continue;

          const output = content.output;
          if (!isTextContentBlockArray(output)) continue;

          const [metadataBlock, ...remainingBlocks] = output;
          const updatedOutput = [
            {
              ...metadataBlock,
              text: `${metadataBlock.text}\n${formatConcurrentEdits(edits)}`,
            },
            ...remainingBlocks,
          ];
          const updatedContent = { ...content, output: updatedOutput };
          const updatedBlockRow = contentForBlockInput({
            id: block.id,
            turnId: block.turnId,
            responseId: block.responseId,
            blockType: "tool_result",
            sequence: block.sequence,
            content: updatedContent,
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
          writeBlocksByDocument.set(documentId, persistedBackfill.result);
          yield* persistedBackfill.events;
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
    try {
      await rollbackActiveResponse();
    } catch (_rollbackError) {
      // Keep the original turn failure visible. rollbackResponse invalidates
      // staged runtimes before surfacing cleanup failures, so a second failure
      // here should not hide the error that broke the response.
    }
    // Unexpected exception (e.g. DB failure, tool crash). If the signal is
    // already aborted, treat as cancellation; otherwise finalize as error.
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
