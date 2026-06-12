/**
 * Runtime loop integration tests: exercise the orchestrator with in-memory
 * repositories, stub gateways, and real persistence projection so turn, block,
 * tool, permission, and journal behavior stay aligned across the loop boundary.
 */

import { EventType } from "@meridian/contracts/protocol";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { JsonValue, OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { deriveJournalTurnId } from "../../../threads/domain/journal-turn-id.js";
import { projectOrchestratorEvents } from "../../../threads/domain/orchestrator-event-projector.js";
import {
  buildThreadSnapshot,
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
  projectReadModelEvent,
} from "../../../threads/index.js";
import { createInMemoryWorkbenchRepository } from "../../../workbenches/index.js";
import {
  createGateway,
  createMockOpenAICompatibleServer,
  type Gateway,
  type GenerateRequest,
  type GenerateResult,
  type MockOpenAIServer,
  mockProviderConfig,
  type StreamEvent,
} from "../../gateway/index.js";
import type {
  CheckpointToolHandlerContext,
  ToolExecutor,
  ToolHandler,
  ToolHandlerContext,
} from "../../tools/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createCheckpointRegistry, EXPIRED_CHECKPOINT_VALUE } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import {
  computeEffectivePermissions,
  createPermissionGate,
  type PermissionGate,
  resolveProfile,
} from "../permissions/index.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

describe("runtime loop integration", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  async function setupOrchestrator(
    toolExecutor?: ToolExecutor,
    gatewayOverride?: Gateway,
    permissionGate?: PermissionGate,
    configureRepos?: (repos: ReturnType<typeof createInMemoryRepositories>) => void,
    workbenchPreferences?: Parameters<typeof createOrchestrator>[0]["workbenchPreferences"],
  ) {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    configureRepos?.(repos);
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "Test Workbench" });
    const eventWriter = createInMemoryEventJournalWriter();
    const checkpointRegistry = createCheckpointRegistry();
    const gateway =
      gatewayOverride ??
      createGateway({
        providers: [mockProviderConfig(mock.baseUrl)],
        defaultModel: "mock-llm-v1",
      });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      workbenchId: workbench.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        toolExecutor: toolExecutor ?? {
          executeTool: async (call) => ({
            toolCallId: call.id,
            output: { conditions: "sunny", temperatureF: 72 },
          }),
        },
        repos,
        eventWriter,
        checkpointRegistry,
        permissionGate:
          permissionGate ??
          createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
        workbenchPreferences: workbenchPreferences ?? {
          async read() {
            return { threadGroupBy: "work", pinnedThreadIds: [], defaultAgentSlug: null };
          },
        },
        creditLedger,
      }),
    );
    return { repos, eventWriter, orchestrator, workbenchId: workbench.id, checkpointRegistry };
  }

  async function collectEvents(
    handleOrGen: AsyncIterable<OrchestratorEvent> | { events: AsyncIterable<OrchestratorEvent> },
  ): Promise<OrchestratorEvent[]> {
    const gen = "events" in handleOrGen ? handleOrGen.events : handleOrGen;
    const events: OrchestratorEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  type InMemoryThreadRepos = ReturnType<typeof createInMemoryRepositories>;

  async function readTurnLevelReadModel(repos: InMemoryThreadRepos, threadId: string) {
    const turns = await repos.turns.listByThread(threadId);
    const turnOrder = new Map(turns.map((turn, index) => [turn.id, index]));
    const responses = (
      await Promise.all(turns.map((turn) => repos.modelResponses.listByTurn(turn.id)))
    )
      .flat()
      .sort((a, b) => {
        const turnDelta = (turnOrder.get(a.turnId) ?? 0) - (turnOrder.get(b.turnId) ?? 0);
        return turnDelta === 0 ? a.sequence - b.sequence : turnDelta;
      });
    const blocks = await repos.blocks.listByThread(threadId);

    return {
      turns: turns.map((turn) => ({
        id: turn.id,
        threadId: turn.threadId,
        prevTurnId: turn.prevTurnId,
        role: turn.role,
        status: turn.status,
        finishReason: turn.finishReason,
        completedAt: turn.completedAt,
        createdAt: turn.createdAt,
        requestParams: turn.requestParams,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        reasoningTokens: turn.reasoningTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens,
        totalCostUsd: turn.totalCostUsd,
        totalMillicredits: turn.totalMillicredits,
        responseCount: turn.responseCount,
        model: turn.model,
        provider: turn.provider,
      })),
      modelResponses: responses.map((response) => ({
        id: response.id,
        turnId: response.turnId,
        sequence: response.sequence,
        provider: response.provider,
        model: response.model,
        providerRequestId: response.providerRequestId,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        reasoningTokens: response.reasoningTokens,
        cacheReadTokens: response.cacheReadTokens,
        cacheWriteTokens: response.cacheWriteTokens,
        costUsd: response.costUsd,
        millicredits: response.millicredits,
        priceSource: response.priceSource,
        pricingSnapshot: response.pricingSnapshot,
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        rawUsage: response.rawUsage,
      })),
      blocks: blocks.map((block) => ({
        id: block.id,
        turnId: block.turnId,
        responseId: block.responseId,
        blockType: block.blockType,
        sequence: block.sequence,
        content: block.content,
      })),
    };
  }

  async function readThreadRow(repos: InMemoryThreadRepos, threadId: string) {
    const thread = await repos.threads.findById(threadId);
    if (!thread) throw new Error(`missing thread row: ${threadId}`);
    return thread;
  }

  async function createEmptyReplayStoreFromThread(
    sourceRepos: InMemoryThreadRepos,
    threadId: string,
  ) {
    const sourceThread = await sourceRepos.threads.findById(threadId);
    if (!sourceThread) throw new Error("missing source thread");

    const workbenchRepo = createInMemoryWorkbenchRepository();
    await workbenchRepo.create({
      id: sourceThread.workbenchId,
      userId: sourceThread.userId,
      title: "Replay Workbench",
    });
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    await repos.threads.create({
      id: sourceThread.id,
      userId: sourceThread.userId,
      workbenchId: sourceThread.workbenchId,
      workId: sourceThread.workId,
      title: sourceThread.title,
      systemPrompt: sourceThread.systemPrompt,
      workingState: sourceThread.workingState,
    });
    return repos;
  }

  async function replayJournalIntoStore(
    repos: InMemoryThreadRepos,
    eventWriter: ReturnType<typeof createInMemoryEventJournalWriter>,
    threadId: string,
  ) {
    const reader = createInMemoryEventJournalReader(eventWriter);
    const journal = await reader.listByThread(threadId);
    for (const entry of journal) {
      expect(entry.turnId).toBe(deriveJournalTurnId(entry.payload));
      await projectReadModelEvent(repos, entry.payload);
    }
    return journal;
  }

  function liveBlockSequencesFromAgui(agui: ReturnType<typeof projectOrchestratorEvents>) {
    const sequences: {
      blockType: "text" | "reasoning" | "tool_use" | "tool_result";
      sequence: number;
    }[] = [];
    const startedToolCalls = new Set<string>();
    let nextSequence = 0;

    for (const event of agui) {
      if (event.type === EventType.TEXT_MESSAGE_START) {
        sequences.push({ blockType: "text", sequence: nextSequence++ });
        continue;
      }
      if (event.type === EventType.REASONING_MESSAGE_START) {
        const [, sequence] = event.messageId.split("::");
        const parsedSequence = Number(sequence);
        expect(parsedSequence).toBe(nextSequence);
        sequences.push({ blockType: "reasoning", sequence: nextSequence++ });
        continue;
      }
      if (event.type === EventType.TOOL_CALL_START && !startedToolCalls.has(event.toolCallId)) {
        startedToolCalls.add(event.toolCallId);
        sequences.push({ blockType: "tool_use", sequence: nextSequence++ });
        continue;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) {
        sequences.push({ blockType: "tool_result", sequence: nextSequence++ });
      }
    }

    return sequences;
  }

  function gatewayFromResults(results: GenerateResult[]): Gateway {
    let index = 0;
    return {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        const result = results[index++];
        if (!result) throw new Error(`No stubbed result for model call ${index}`);
        const firstText = result.content.find((part) => part.type === "text");
        if (firstText?.type === "text") {
          yield { type: "text.delta", text: firstText.text };
        }
        yield { type: "end", result };
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in these tests");
      },
    };
  }

  function getWeatherToolDefinition() {
    return {
      type: "function" as const,
      name: "get_weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: { location: { type: "string" } },
      },
    };
  }

  function getMockCheckpointToolDefinition() {
    return {
      type: "function" as const,
      name: "mock_checkpoint",
      description: "Mock checkpoint",
      inputSchema: {
        type: "object",
        properties: {
          checkpointId: { type: "string" },
          recommended: {},
          requiresHuman: { type: "boolean" },
          timeoutMs: { type: "number" },
        },
        required: ["checkpointId"],
      },
    };
  }

  function createMockCheckpointToolExecutor(): ToolExecutor {
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: getMockCheckpointToolDefinition(),
      capability: "checkpoint",
      execution: {
        type: "server",
        handler: (async (input, ctx) => {
          const args = input as {
            checkpointId: string;
            recommended?: unknown;
            requiresHuman?: boolean;
            timeoutMs?: number;
          };
          const response = await ctx.checkpoint(
            {
              checkpointId: args.checkpointId,
              prompt: "Mock checkpoint",
              artifacts: [],
              answerSchema: { type: "object", properties: { value: { type: "string" } } },
              recommended: (args.recommended as JsonValue | undefined) ?? null,
              requiresHuman: args.requiresHuman ?? false,
            },
            args.timeoutMs ?? ctx.checkpointTimeoutMs,
          );
          await ctx.updateComponentBlock(args.checkpointId, {
            resolvedValue: response.value,
            answerProvenance: response.provenance,
          });
          return response;
        }) as ToolHandler<CheckpointToolHandlerContext>,
      },
    });
    return createToolExecutor(registry);
  }

  function checkpointGateway(input: {
    checkpointId: string;
    recommended?: unknown;
    requiresHuman?: boolean;
    timeoutMs?: number;
  }): Gateway & { getCallCount(): number } {
    let call = 0;
    return {
      getCallCount: () => call,
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: {
              content: [
                {
                  type: "tool_use",
                  toolCallId: "call-checkpoint",
                  toolName: "mock_checkpoint",
                  input,
                },
              ],
              toolCalls: [],
              finishReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1 },
              model: "stub-model",
              provider: "stub",
            },
          };
          return;
        }
        if (call === 2) {
          yield {
            type: "end",
            result: {
              content: [{ type: "text", text: "continued" }],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 2, outputTokens: 2 },
              model: "stub-model",
              provider: "stub",
            },
          };
          return;
        }
        throw new Error(`unexpected model call ${call}`);
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in this test");
      },
    };
  }

  async function waitForJournalEvent(
    writer: ReturnType<typeof createInMemoryEventJournalWriter>,
    threadId: string,
    type: OrchestratorEvent["type"],
  ): Promise<void> {
    const startedAt = Date.now();
    while (!writer.getEvents(threadId).some((entry) => entry.event.type === type)) {
      if (Date.now() - startedAt > 1000) {
        throw new Error(`timed out waiting for journal event ${type}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function createWeatherToolExecutor(): ToolExecutor {
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: getWeatherToolDefinition(),
      execution: {
        type: "server",
        handler: async () => ({ conditions: "sunny", temperatureF: 72 }),
      },
    });
    return createToolExecutor(registry);
  }

  function representativeToolGateway(): Gateway {
    return gatewayFromResults([
      {
        content: [
          { type: "reasoning", text: "I should use the weather tool." },
          { type: "text", text: "I'll check the weather." },
          {
            type: "tool_use",
            toolCallId: "call-weather-rebuild",
            toolName: "get_weather",
            input: { location: "San Francisco" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          reasoningTokens: 3,
          estimatedCostUsd: 0.001,
        },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [
          { type: "reasoning", text: "The weather result is available." },
          { type: "text", text: "It is sunny in San Francisco." },
        ],
        toolCalls: [],
        finishReason: "end_turn",
        usage: {
          inputTokens: 14,
          outputTokens: 7,
          reasoningTokens: 2,
          estimatedCostUsd: 0.002,
        },
        model: "stub-model",
        provider: "stub",
      },
    ]);
  }

  function positionalTextResumeGateway(): Gateway {
    let call = 0;
    return {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield { type: "reasoning.delta", text: "Need weather data." };
          yield { type: "text.delta", text: "I'll check it." };
          yield {
            type: "tool_call.delta",
            id: "call-text-resume-tool",
            name: "get_weather",
            argumentsDelta: '{"location":"Chicago"}',
          };
          yield {
            type: "end",
            result: {
              content: [
                { type: "reasoning", text: "Need weather data." },
                { type: "text", text: "I'll check it." },
                {
                  type: "tool_use",
                  toolCallId: "call-text-resume-tool",
                  toolName: "get_weather",
                  input: { location: "Chicago" },
                },
              ],
              toolCalls: [],
              finishReason: "tool_use",
              usage: { inputTokens: 4, outputTokens: 8 },
              model: "stub-model",
              provider: "stub",
            },
          };
          return;
        }

        if (call === 2) {
          yield { type: "text.delta", text: "It is sunny." };
          yield {
            type: "end",
            result: {
              content: [{ type: "text", text: "It is sunny." }],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 6, outputTokens: 5 },
              model: "stub-model",
              provider: "stub",
            },
          };
          return;
        }

        throw new Error(`unexpected model call ${call}`);
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in these tests");
      },
    };
  }

  function positionalReasoningGateway(): Gateway {
    let call = 0;
    return {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield { type: "reasoning.delta", text: "Need data." };
          yield { type: "text.delta", text: "I'll inspect it." };
          yield {
            type: "tool_call.delta",
            id: "call-positional-tool",
            name: "get_weather",
            argumentsDelta: '{"location":"Chicago"}',
          };
          yield {
            type: "end",
            result: {
              content: [
                { type: "reasoning", text: "Need data." },
                { type: "text", text: "I'll inspect it." },
                {
                  type: "tool_use",
                  toolCallId: "call-positional-tool",
                  toolName: "get_weather",
                  input: { location: "Chicago" },
                },
              ],
              toolCalls: [],
              finishReason: "tool_use",
              usage: { inputTokens: 3, outputTokens: 7 },
              model: "stub-model",
              provider: "stub",
            },
          };
          return;
        }

        if (call === 2) {
          yield { type: "reasoning.delta", text: "Tool result is enough." };
          yield { type: "text.delta", text: "It is sunny." };
          yield {
            type: "end",
            result: {
              content: [
                { type: "reasoning", text: "Tool result is enough." },
                { type: "text", text: "It is sunny." },
              ],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 5, outputTokens: 11 },
              model: "stub-model",
              provider: "stub",
            },
          };
          return;
        }

        throw new Error(`unexpected model call ${call}`);
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in these tests");
      },
    };
  }

  it("runs a simple text turn end-to-end", async () => {
    const { repos, orchestrator, workbenchId } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "hello there",
      }),
    );

    const created = events.filter((e) => e.type === "turn.created");
    expect(created).toHaveLength(2);
    expect(created[0]?.type === "turn.created" && created[0].turn.role).toBe("user");
    expect(created[1]?.type === "turn.created" && created[1].turn.role).toBe("assistant");

    expect(events.some((e) => e.type === "stream.delta")).toBe(true);

    const assistantCreated = created[1];
    if (assistantCreated?.type !== "turn.created") throw new Error("missing assistant turn");

    const responses = await repos.modelResponses.listByTurn(assistantCreated.turn.id);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.outputTokens).toBeGreaterThan(0);

    const completed = events.find((e) => e.type === "turn.completed");
    expect(completed?.type).toBe("turn.completed");
    if (completed?.type === "turn.completed") {
      expect(completed.turn.status).toBe("complete");
    }
  });

  it("projects the user text block in the same setup transaction as the user turn", async () => {
    const gateway = gatewayFromResults([
      {
        content: [{ type: "text", text: "hello back" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const writeLog: Array<{
      operation: "block.create" | "block.upsert" | "turn.create";
      txId: number | null;
      id?: string;
      turnId?: string;
      blockType?: string;
      sequence?: number;
      responseId?: string | null;
    }> = [];
    let activeTxId: number | null = null;
    let nextTxId = 0;

    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      undefined,
      gateway,
      undefined,
      (repos) => {
        const originalTransaction = repos.transaction.bind(repos);
        repos.transaction = async (operation) => {
          const previousTxId = activeTxId;
          const txId = ++nextTxId;
          activeTxId = txId;
          try {
            return await originalTransaction(operation);
          } finally {
            activeTxId = previousTxId;
          }
        };

        const originalTurnCreate = repos.turns.create.bind(repos.turns);
        repos.turns.create = async (input) => {
          const turn = await originalTurnCreate(input);
          writeLog.push({
            operation: "turn.create",
            txId: activeTxId,
            id: turn.id,
            turnId: turn.id,
          });
          return turn;
        };

        const blockRepo = repos.blocks;
        const originalBlockCreate = blockRepo.create.bind(blockRepo);
        blockRepo.create = async (input) => {
          writeLog.push({
            operation: "block.create",
            txId: activeTxId,
            turnId: input.turnId,
            blockType: input.blockType,
            sequence: input.sequence,
            responseId: input.responseId ?? null,
          });
          return originalBlockCreate(input);
        };

        const originalBlockUpsert = blockRepo.upsert.bind(blockRepo);
        blockRepo.upsert = async (input) => {
          writeLog.push({
            operation: "block.upsert",
            txId: activeTxId,
            id: input.id,
            turnId: input.turnId,
            blockType: input.blockType,
            sequence: input.sequence,
            responseId: input.responseId ?? null,
          });
          return originalBlockUpsert(input);
        };
      },
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "hello there",
      }),
    );

    expect(events.slice(0, 3).map((event) => event.type)).toEqual([
      "turn.created",
      "block.upserted",
      "turn.created",
    ]);
    const userCreated = events[0];
    const userBlockEvent = events[1];
    if (userCreated?.type !== "turn.created" || userBlockEvent?.type !== "block.upserted") {
      throw new Error("missing setup user turn/block events");
    }
    expect(userBlockEvent.block).toMatchObject({
      turnId: userCreated.turn.id,
      responseId: null,
      blockType: "text",
      sequence: 0,
      content: "hello there",
      status: "complete",
    });

    const userTurnCreate = writeLog.find(
      (entry) => entry.operation === "turn.create" && entry.id === userCreated.turn.id,
    );
    const userBlockUpsert = writeLog.find(
      (entry) =>
        entry.operation === "block.upsert" &&
        entry.turnId === userCreated.turn.id &&
        entry.blockType === "text" &&
        entry.sequence === 0,
    );
    expect(userTurnCreate?.txId).toBe(1);
    expect(userBlockUpsert?.txId).toBe(userTurnCreate?.txId);
    expect(writeLog.some((entry) => entry.operation === "block.create")).toBe(false);

    const userBlocks = await repos.blocks.listByTurn(userCreated.turn.id);
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0]).toMatchObject({
      responseId: null,
      textContent: "hello there",
      content: "hello there",
      sequence: 0,
    });
  });

  it("accumulates model response cost into turn rollups and thread total across turns", async () => {
    const gateway = gatewayFromResults([
      {
        content: [{ type: "text", text: "first response" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 4 },
        model: "gpt-4.1-mini",
        provider: "openai",
      },
      {
        content: [{ type: "text", text: "second response" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 6 },
        model: "gpt-4.1-mini",
        provider: "openai",
      },
    ]);
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(undefined, gateway);
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const firstEvents = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "first" }),
    );
    const secondEvents = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "second" }),
    );

    const assistantTurns = [...firstEvents, ...secondEvents].filter(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    expect(assistantTurns).toHaveLength(2);
    const [firstAssistant, secondAssistant] = assistantTurns;
    if (!firstAssistant || !secondAssistant) {
      throw new Error("expected two assistant turns");
    }

    const firstResponses = await repos.modelResponses.listByTurn(firstAssistant.turn.id);
    const secondResponses = await repos.modelResponses.listByTurn(secondAssistant.turn.id);
    expect(firstResponses).toHaveLength(1);
    expect(secondResponses).toHaveLength(1);
    expect(firstResponses[0]?.costUsd).toBe("0.000007");
    expect(secondResponses[0]?.costUsd).toBe("0.000011");
    expect(firstResponses[0]?.priceSource).toBe("computed");

    const firstTurn = await repos.turns.findById(firstAssistant.turn.id);
    const secondTurn = await repos.turns.findById(secondAssistant.turn.id);
    expect(firstTurn?.totalCostUsd).toBe("0.000007");
    expect(secondTurn?.totalCostUsd).toBe("0.000011");
    expect(firstTurn?.responseCount).toBe(1);
    expect(secondTurn?.responseCount).toBe(1);

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.totalCostUsd).toBe("0.000018");
    expect(threadAfter?.turnCount).toBe(2);
  });

  it("loops on tool_use until end_turn", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-weather",
            toolName: "get_weather",
            input: { location: "San Francisco" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 12, outputTokens: 8 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "It is sunny in San Francisco." }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 14, outputTokens: 7 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        inputSchema: {
          type: "object",
          properties: { location: { type: "string" } },
        },
      },
      execution: {
        type: "server",
        handler: async () => ({ conditions: "sunny", temperatureF: 72 }),
      },
    });
    const toolExecutor = createToolExecutor(registry);
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(toolExecutor, gateway);
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "What's the weather in SF?",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather",
            inputSchema: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        ],
      }),
    );

    const assistantCreated = events.filter(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    )[0];
    if (!assistantCreated) throw new Error("missing assistant turn");

    const responses = await repos.modelResponses.listByTurn(assistantCreated.turn.id);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.finishReason).toBe("tool_use");
    expect(responses[1]?.finishReason).toBe("end_turn");

    const assistantTurn = await repos.turns.findById(assistantCreated.turn.id);
    const summedOutput = responses.reduce((n: number, r) => n + r.outputTokens, 0);
    const summedInput = responses.reduce((n: number, r) => n + r.inputTokens, 0);
    expect(assistantTurn?.outputTokens).toBe(summedOutput);
    expect(assistantTurn?.inputTokens).toBe(summedInput);
    expect(assistantTurn?.responseCount).toBe(2);

    const blocks = await repos.blocks.listByTurn(assistantCreated.turn.id);
    const toolResultBlock = blocks.find((b) => b.blockType === "tool_result");
    expect(toolResultBlock).toMatchObject({
      responseId: null,
      sequence: 1,
      content: {
        toolCallId: "call-weather",
        output: { conditions: "sunny", temperatureF: 72 },
      },
    });
    const toolResultBlockEvent = events.find(
      (e) => e.type === "block.upserted" && e.block.blockType === "tool_result",
    );
    expect(toolResultBlockEvent?.type).toBe("block.upserted");
    if (toolResultBlockEvent?.type === "block.upserted") {
      expect(toolResultBlockEvent.block).toMatchObject({
        turnId: assistantCreated.turn.id,
        responseId: null,
        sequence: 1,
      });
    }

    expect(events.some((e) => e.type === "tool.executing")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.completed");

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("idle");
  });

  it("streams tool output deltas live and yields them before the tool result", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-streaming-output",
            toolName: "streaming_tool",
            input: {},
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 3, outputTokens: 2 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "done" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const registry = createToolRegistry();
    let finishTool!: () => void;
    const toolMayFinish = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "streaming_tool",
        description: "Streams output",
        inputSchema: { type: "object" },
      },
      execution: {
        type: "server",
        handler: async (_input: unknown, ctx: ToolHandlerContext) => {
          ctx.emitOutputDelta?.({ stream: "stdout", text: "hi" });
          await toolMayFinish;
          return { ok: true };
        },
      },
    });
    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator(
      createToolExecutor(registry),
      gateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "stream",
      tools: [registry.getDefinitions()[0] ?? getWeatherToolDefinition()],
    });
    const eventsPromise = collectEvents(handle);

    let waitError: unknown;
    try {
      await waitForJournalEvent(eventWriter, thread.id, "tool.output_delta");
      expect(
        eventWriter.getEvents(thread.id).some((entry) => entry.event.type === "tool.result"),
      ).toBe(false);
    } catch (error) {
      waitError = error;
    } finally {
      finishTool();
    }
    if (waitError) throw waitError;

    const events = await eventsPromise;
    const delta = events.find((event) => event.type === "tool.output_delta");
    expect(delta).toEqual({
      type: "tool.output_delta",
      toolCallId: "call-streaming-output",
      stream: "stdout",
      text: "hi",
    });

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.indexOf("tool.output_delta")).toBeLessThan(eventTypes.indexOf("tool.result"));
  });

  it("suspends on a mock checkpoint without re-entering the gateway, then resumes on response", async () => {
    const gateway = checkpointGateway({ checkpointId: "checkpoint-user" });
    const { repos, eventWriter, orchestrator, workbenchId, checkpointRegistry } =
      await setupOrchestrator(createMockCheckpointToolExecutor(), gateway);
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "pause",
      tools: [getMockCheckpointToolDefinition()],
    });
    const eventsPromise = collectEvents(handle);

    await waitForJournalEvent(eventWriter, thread.id, "checkpoint.created");

    const checkpointCreated = eventWriter
      .getEvents(thread.id)
      .map((entry) => entry.event)
      .find((event) => event.type === "checkpoint.created");
    expect(checkpointCreated?.type).toBe("checkpoint.created");
    if (checkpointCreated?.type === "checkpoint.created") {
      expect(checkpointCreated.request).toMatchObject({
        checkpointId: "checkpoint-user",
        answerSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      });
    }
    const assistantTurnId =
      checkpointCreated?.type === "checkpoint.created" ? checkpointCreated.turnId : "";
    const waitingTurn = await repos.turns.findById(assistantTurnId);
    expect(waitingTurn?.status).toBe("waiting_checkpoint");
    expect(gateway.getCallCount()).toBe(1);

    expect(
      checkpointRegistry.resolve({
        threadId: thread.id,
        turnId: assistantTurnId,
        checkpointId: "checkpoint-user",
        value: { value: "approved" },
      }),
    ).toEqual({ ok: true });

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "checkpoint.resolved")).toBe(true);
    expect(gateway.getCallCount()).toBe(2);

    const blocks = await repos.blocks.listByTurn(assistantTurnId);
    const toolResult = blocks.find((block) => block.blockType === "tool_result");
    expect(toolResult?.content).toMatchObject({
      toolCallId: "call-checkpoint",
      output: { value: { value: "approved" }, provenance: "user" },
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("accepts a checkpoint response sent synchronously when checkpoint.created is appended", async () => {
    const gateway = checkpointGateway({ checkpointId: "checkpoint-immediate" });
    const { repos, eventWriter, orchestrator, workbenchId, checkpointRegistry } =
      await setupOrchestrator(createMockCheckpointToolExecutor(), gateway);
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    let immediateResolveResult: ReturnType<(typeof checkpointRegistry)["resolve"]> | null = null;
    const appendEvent = eventWriter.appendEvent.bind(eventWriter);
    eventWriter.appendEvent = async (threadId, event) => {
      const appended = await appendEvent(threadId, event);
      if (event.type === "checkpoint.created") {
        immediateResolveResult = checkpointRegistry.resolve({
          threadId,
          turnId: event.turnId,
          checkpointId: event.checkpointId,
          value: { value: "instant" },
        });
      }
      return appended;
    };

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "pause",
      tools: [getMockCheckpointToolDefinition()],
    });
    const events = await collectEvents(handle);

    expect(immediateResolveResult).toEqual({ ok: true });
    expect(events.some((event) => event.type === "checkpoint.resolved")).toBe(true);
    expect(gateway.getCallCount()).toBe(2);
  });

  it("continues with the recommended value when a checkpoint times out with auto-resume enabled", async () => {
    const gateway = checkpointGateway({
      checkpointId: "checkpoint-auto",
      recommended: "safe-default",
      timeoutMs: 15,
    });
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      createMockCheckpointToolExecutor(),
      gateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "pause",
        tools: [getMockCheckpointToolDefinition()],
      }),
    );

    const assistantCreated = events.find(
      (event): event is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        event.type === "turn.created" && event.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    expect(events.some((event) => event.type === "checkpoint.expired")).toBe(true);
    const blocks = await repos.blocks.listByTurn(assistantCreated.turn.id);
    const toolResult = blocks.find((block) => block.blockType === "tool_result");
    expect(toolResult?.content).toMatchObject({
      output: { value: "safe-default", provenance: "auto" },
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("continues with an expired sentinel when auto-resume is disabled", async () => {
    const gateway = checkpointGateway({
      checkpointId: "checkpoint-disabled",
      recommended: "safe-default",
      timeoutMs: 15,
    });
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      createMockCheckpointToolExecutor(),
      gateway,
      undefined,
      undefined,
      {
        read: async () => ({
          threadGroupBy: "work",
          pinnedThreadIds: [],
          defaultAgentSlug: null,
          autoResume: { enabled: false, timeoutMs: 15 },
        }),
      },
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "pause",
        tools: [getMockCheckpointToolDefinition()],
      }),
    );

    const assistantCreated = events.find(
      (event): event is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        event.type === "turn.created" && event.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    expect(events.some((event) => event.type === "checkpoint.expired")).toBe(true);
    const blocks = await repos.blocks.listByTurn(assistantCreated.turn.id);
    const toolResult = blocks.find((block) => block.blockType === "tool_result");
    expect(toolResult?.content).toMatchObject({
      output: { value: EXPIRED_CHECKPOINT_VALUE, provenance: "auto" },
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("does not expire an unresolved checkpoint while this process still has live runner state", async () => {
    const { repos, eventWriter, workbenchId, checkpointRegistry } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const turn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "waiting_checkpoint",
    });
    await eventWriter.appendEvent(thread.id, {
      type: "checkpoint.created",
      turnId: turn.id,
      checkpointId: "checkpoint-live",
      blockSequence: 0,
      request: {
        checkpointId: "checkpoint-live",
        prompt: "test",
        artifacts: [],
        answerSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    const journalReader = createInMemoryEventJournalReader(eventWriter);

    await expect(
      checkpointRegistry.recoverPendingCheckpoints({
        repos,
        journalReader,
        journalWriter: eventWriter,
        threadId: thread.id,
        hasLivePendingCheckpoint: () => true,
        getLiveRunnerTurnId: () => turn.id,
      }),
    ).resolves.toEqual([]);

    expect((await repos.turns.findById(turn.id))?.status).toBe("waiting_checkpoint");
    expect(
      eventWriter.getEvents(thread.id).filter((entry) => entry.event.type === "checkpoint.expired"),
    ).toHaveLength(0);
  });

  it("cancelled checkpoint turns close recovery without being resurrected", async () => {
    const { repos, eventWriter, workbenchId, checkpointRegistry } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const turn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "cancelled",
    });
    await eventWriter.appendEvent(thread.id, {
      type: "checkpoint.created",
      turnId: turn.id,
      checkpointId: "checkpoint-cancelled",
      blockSequence: 0,
      request: {
        checkpointId: "checkpoint-cancelled",
        prompt: "test",
        artifacts: [],
        answerSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    const journalReader = createInMemoryEventJournalReader(eventWriter);

    const recovered = await checkpointRegistry.recoverPendingCheckpoints({
      repos,
      journalReader,
      journalWriter: eventWriter,
      threadId: thread.id,
    });

    expect(recovered).toEqual([]);
    expect((await repos.turns.findById(turn.id))?.status).toBe("cancelled");
    expect(
      eventWriter.getEvents(thread.id).filter((entry) => entry.event.type === "checkpoint.expired"),
    ).toHaveLength(0);
  });

  it("restart recovery is idempotent under concurrent subscribers", async () => {
    const { repos, eventWriter, workbenchId, checkpointRegistry } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const turn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "waiting_checkpoint",
    });
    await eventWriter.appendEvent(thread.id, {
      type: "checkpoint.created",
      turnId: turn.id,
      checkpointId: "checkpoint-concurrent",
      blockSequence: 0,
      request: {
        checkpointId: "checkpoint-concurrent",
        prompt: "test",
        artifacts: [],
        answerSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    const journalReader = createInMemoryEventJournalReader(eventWriter);

    await Promise.all([
      checkpointRegistry.recoverPendingCheckpoints({
        repos,
        journalReader,
        journalWriter: eventWriter,
        threadId: thread.id,
      }),
      checkpointRegistry.recoverPendingCheckpoints({
        repos,
        journalReader,
        journalWriter: eventWriter,
        threadId: thread.id,
      }),
    ]);

    const events = eventWriter.getEvents(thread.id).map((entry) => entry.event);
    expect(events.filter((event) => event.type === "checkpoint.expired")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.error")).toHaveLength(1);
  });

  it("restart recovery expires unresolved checkpoints into a terminal error across list and snapshot", async () => {
    const { repos, eventWriter, workbenchId, checkpointRegistry } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const turn = await repos.turns.create({
      threadId: thread.id,
      role: "assistant",
      status: "waiting_checkpoint",
    });
    await eventWriter.appendEvent(thread.id, {
      type: "checkpoint.created",
      turnId: turn.id,
      checkpointId: "checkpoint-restart",
      blockSequence: 0,
      request: {
        checkpointId: "checkpoint-restart",
        prompt: "test",
        artifacts: [],
        answerSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
    const journalReader = createInMemoryEventJournalReader(eventWriter);

    const recovered = await checkpointRegistry.recoverPendingCheckpoints({
      repos,
      journalReader,
      journalWriter: eventWriter,
      threadId: thread.id,
    });

    expect(recovered).toMatchObject([
      {
        type: "checkpoint.expired",
        turnId: turn.id,
        checkpointId: "checkpoint-restart",
      },
      {
        type: "turn.error",
        turn: { id: turn.id, status: "error" },
        error: {
          code: "checkpoint_interrupted",
          message: "Checkpoint interrupted by server restart before it could be resumed.",
          retryable: false,
          source: "system",
        },
      },
    ]);
    const recoveredTurn = await repos.turns.findById(turn.id);
    expect(recoveredTurn?.status).toBe("error");
    expect((await repos.threads.findById(thread.id))?.status).toBe("error");

    const [listItem] = await repos.threads.listByWorkbench(workbenchId);
    expect(listItem?.runningTurnId).toBeNull();

    const hub = createThreadEventHub({
      journalWriter: eventWriter,
      journalReader,
      eventSink: createInMemoryEventSink(),
    });
    const snapshot = await buildThreadSnapshot(
      repos,
      hub,
      { getRunningTurnId: () => null },
      thread.id,
    );
    expect(snapshot.liveState.status).toBe("error");
    expect(snapshot.liveState.runningTurnId).toBeNull();
  });

  it("emits reasoning message ids with the same positional sequences as persisted blocks", async () => {
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      createWeatherToolExecutor(),
      positionalReasoningGateway(),
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "Check Chicago.",
        tools: [getWeatherToolDefinition()],
      }),
    );

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const agui = projectOrchestratorEvents(events);
    const liveReasoningSequences = agui
      .filter((event) => event.type === EventType.REASONING_MESSAGE_START)
      .map((event) => {
        const [turnId, sequence] = event.messageId.split("::");
        expect(turnId).toBe(assistantCreated.turn.id);
        return Number(sequence);
      });
    const persistedReasoningSequences = (await repos.blocks.listByTurn(assistantCreated.turn.id))
      .filter((block) => block.blockType === "reasoning")
      .map((block) => block.sequence);

    expect(persistedReasoningSequences).toEqual([0, 4]);
    expect(liveReasoningSequences).toEqual(persistedReasoningSequences);
  });

  it("keeps live text sequences aligned when a tool response resumes directly with text", async () => {
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      createWeatherToolExecutor(),
      positionalTextResumeGateway(),
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "Check Chicago.",
        tools: [getWeatherToolDefinition()],
      }),
    );

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const agui = projectOrchestratorEvents(events);
    const liveSequences = liveBlockSequencesFromAgui(agui);
    const blocks = await repos.blocks.listByTurn(assistantCreated.turn.id);
    const persistedSequences = blocks.map((block) => ({
      blockType: block.blockType,
      sequence: block.sequence,
    }));

    expect(blocks.map((block) => block.blockType)).toEqual([
      "reasoning",
      "text",
      "tool_use",
      "tool_result",
      "text",
    ]);
    expect(liveSequences.filter((frontier) => frontier.blockType === "reasoning")).toEqual(
      persistedSequences.filter((block) => block.blockType === "reasoning"),
    );
    expect(liveSequences.filter((frontier) => frontier.blockType === "text")).toEqual(
      persistedSequences.filter((block) => block.blockType === "text"),
    );
    expect(persistedSequences.filter((block) => block.blockType === "text")).toEqual([
      { blockType: "text", sequence: 1 },
      { blockType: "text", sequence: 4 },
    ]);
  });

  it("rebuilds the turn-level read model from journal events given an existing thread row", async () => {
    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator(
      createWeatherToolExecutor(),
      representativeToolGateway(),
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "What's the weather in SF?",
        tools: [getWeatherToolDefinition()],
      }),
    );

    const live = await readTurnLevelReadModel(repos, thread.id);
    const rebuiltRepos = await createEmptyReplayStoreFromThread(repos, thread.id);
    const journal = await replayJournalIntoStore(rebuiltRepos, eventWriter, thread.id);
    const rebuilt = await readTurnLevelReadModel(rebuiltRepos, thread.id);

    expect(journal.map((entry) => entry.seq)).toEqual(
      Array.from({ length: journal.length }, (_, index) => BigInt(index + 1)),
    );
    // This assertion intentionally covers only projector-owned turn-level read-model rows.
    // Thread-level rollups/lifecycle fields (`turnCount`, thread `status`, thread `updatedAt`)
    // still have direct-write state and remain the P4 journaling/rebuild task.
    expect(live).toEqual(rebuilt);
    expect(rebuilt.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(rebuilt.modelResponses).toHaveLength(2);
    expect(rebuilt.blocks.map((block) => block.blockType)).toEqual([
      "text",
      "reasoning",
      "text",
      "tool_use",
      "tool_result",
      "reasoning",
      "text",
    ]);
  });

  it("replaying the same journal twice into one store is idempotent, including the thread row", async () => {
    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator(
      createWeatherToolExecutor(),
      representativeToolGateway(),
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "What's the weather in SF?",
        tools: [getWeatherToolDefinition()],
      }),
    );

    const rebuiltRepos = await createEmptyReplayStoreFromThread(repos, thread.id);
    await replayJournalIntoStore(rebuiltRepos, eventWriter, thread.id);
    const afterSingleReplay = await readTurnLevelReadModel(rebuiltRepos, thread.id);
    const threadAfterSingleReplay = await readThreadRow(rebuiltRepos, thread.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await replayJournalIntoStore(rebuiltRepos, eventWriter, thread.id);
    const afterDoubleReplay = await readTurnLevelReadModel(rebuiltRepos, thread.id);
    const threadAfterDoubleReplay = await readThreadRow(rebuiltRepos, thread.id);

    expect(afterDoubleReplay).toEqual(afterSingleReplay);
    expect(threadAfterDoubleReplay).toEqual(threadAfterSingleReplay);
    expect(threadAfterDoubleReplay.updatedAt).toBe(threadAfterSingleReplay.updatedAt);
    expect(threadAfterDoubleReplay.totalCostUsd).toBe("0.000000");
    const assistantTurn = afterDoubleReplay.turns.find((turn) => turn.role === "assistant");
    expect(assistantTurn).toMatchObject({
      inputTokens: 26,
      outputTokens: 15,
      reasoningTokens: 5,
      totalCostUsd: "0.000000",
      responseCount: 2,
    });
    expect(afterDoubleReplay.modelResponses).toHaveLength(2);
  });

  it("denies a write tool via permission gate without calling the executor", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-write-denied",
            toolName: "write",
            input: { path: "kb://notes.md", content: "x" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 6 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "I cannot run that command." }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 5 },
        model: "stub-model",
        provider: "stub",
      },
    ]);

    let executeCalled = false;
    const restrictedGate = createPermissionGate(
      computeEffectivePermissions({ tools: { allow: ["*"], deny: ["write"] } }),
    );
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      {
        executeTool: async () => {
          executeCalled = true;
          return { toolCallId: "should-not-run", output: {} };
        },
      },
      gateway,
      restrictedGate,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "write notes",
        tools: [
          {
            type: "function",
            name: "write",
            description: "Write file",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(executeCalled).toBe(false);

    const denied = events.find((e) => e.type === "permission.denied");
    expect(denied?.type).toBe("permission.denied");
    if (denied?.type === "permission.denied") {
      expect(denied.toolName).toBe("write");
      expect(denied.reason).toBeTruthy();
    }

    expect(events.some((e) => e.type === "tool.executing")).toBe(false);

    const toolResultEvent = events.find((e) => e.type === "tool.result");
    expect(toolResultEvent?.type).toBe("tool.result");
    if (toolResultEvent?.type === "tool.result") {
      expect(toolResultEvent.isError).toBe(true);
      expect(toolResultEvent.output).toMatchObject({
        error: "permission_denied",
      });
    }

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const blocks = await repos.blocks.listByTurn(assistantCreated.turn.id);
    const toolResultBlock = blocks.find((b) => b.blockType === "tool_result");
    expect(toolResultBlock).toMatchObject({
      responseId: null,
      sequence: 1,
      content: {
        isError: true,
        output: { error: "permission_denied" },
      },
    });
    const deniedBlockEvent = events.find(
      (e) => e.type === "block.upserted" && e.block.blockType === "tool_result",
    );
    expect(deniedBlockEvent?.type).toBe("block.upserted");
    if (deniedBlockEvent?.type === "block.upserted") {
      expect(deniedBlockEvent.block.responseId).toBeNull();
      expect(deniedBlockEvent.block.turnId).toBe(assistantCreated.turn.id);
    }

    expect(events.at(-1)?.type).toBe("turn.completed");
    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("idle");
  });

  it("cost cap blocks the next model call on a chat-only turn", async () => {
    let streamCalls = 0;
    const gateway: Gateway = {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        streamCalls += 1;
        yield { type: "text.delta", text: "expensive reply" };
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "expensive reply" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 1.5 },
            model: "stub-model",
            provider: "stub",
          },
        };
      },
      async generate() {
        throw new Error("not used in these tests");
      },
    };

    const restrictedGate = createPermissionGate(
      computeEffectivePermissions({ tools: { allow: ["*"], deny: ["write"] } }),
    );
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      undefined,
      gateway,
      restrictedGate,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const turn1Events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "first" }),
    );
    expect(streamCalls).toBe(1);
    expect(turn1Events.some((e) => e.type === "turn.completed")).toBe(true);

    const callsBeforeTurn2 = streamCalls;
    const turn2Events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "second",
        treeBudget: createDefaultTreeBudget({ maxCostMillicredits: 0 }),
      }),
    );
    expect(streamCalls).toBe(callsBeforeTurn2);

    const turnError = turn2Events.find((e) => e.type === "turn.error");
    expect(turnError?.type).toBe("turn.error");
    if (turnError?.type === "turn.error") {
      expect(turnError.error.code).toBe("cost_budget_exceeded");
    }

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("error");
  });

  it("handles multiple tool calls in one response with partial policy denials", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-write",
            toolName: "write",
            input: { path: "kb://notes.md", content: "x" },
          },
          {
            type: "tool_use",
            toolCallId: "call-read",
            toolName: "read",
            input: { path: "kb://notes.md" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 6 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "Done." }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 5 },
        model: "stub-model",
        provider: "stub",
      },
    ]);

    const executedTools: string[] = [];
    const restrictedGate = createPermissionGate(
      computeEffectivePermissions({ tools: { allow: ["*"], deny: ["write"] } }),
    );
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      {
        executeTool: async (call) => {
          executedTools.push(call.name);
          return { toolCallId: call.id, output: { ok: true } };
        },
      },
      gateway,
      restrictedGate,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "write and read",
        tools: [
          {
            type: "function",
            name: "write",
            description: "Write file",
            inputSchema: { type: "object" },
          },
          {
            type: "function",
            name: "read",
            description: "Read file",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(executedTools).toEqual(["read"]);
    expect(executedTools).not.toContain("write");

    const denied = events.find((e) => e.type === "permission.denied");
    expect(denied?.type).toBe("permission.denied");
    if (denied?.type === "permission.denied") {
      expect(denied.toolName).toBe("write");
    }

    const toolResultEvents = events.filter((e) => e.type === "tool.result");
    expect(toolResultEvents).toHaveLength(2);

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const toolResultBlocks = (await repos.blocks.listByTurn(assistantCreated.turn.id)).filter(
      (b) => b.blockType === "tool_result",
    );
    expect(toolResultBlocks).toHaveLength(2);
    const sequences = toolResultBlocks.map((b) => b.sequence);
    for (let i = 1; i < sequences.length; i++) {
      const prev = sequences[i - 1] ?? Number.NEGATIVE_INFINITY;
      const current = sequences[i] ?? Number.NEGATIVE_INFINITY;
      expect(current).toBeGreaterThan(prev);
    }
    expect(new Set(sequences).size).toBe(sequences.length);

    expect(events.at(-1)?.type).toBe("turn.completed");
    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("idle");
  });

  it("persists tool execution failures as tool_result blocks and continues the loop", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-weather-failure",
            toolName: "get_weather",
            input: { location: "San Francisco" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 12, outputTokens: 8 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "I could not fetch the weather." }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 14, outputTokens: 7 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      {
        executeTool: async (call) => ({
          toolCallId: call.id,
          output: { message: "weather service unavailable" },
          isError: true,
        }),
      },
      gateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "What's the weather in SF?",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const toolResultEvent = events.find((e) => e.type === "tool.result");
    expect(toolResultEvent?.type).toBe("tool.result");
    if (toolResultEvent?.type === "tool.result") {
      expect(toolResultEvent.isError).toBe(true);
    }

    const blocks = await repos.blocks.listByTurn(assistantCreated.turn.id);
    const toolResultBlock = blocks.find((b) => b.blockType === "tool_result");
    expect(toolResultBlock?.content).toMatchObject({ isError: true });
    expect(events.at(-1)?.type).toBe("turn.completed");

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("idle");
  });

  it("persists monotonic event journal sequences without gaps across turns", async () => {
    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "ping",
      }),
    );
    await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "pong",
      }),
    );

    const recorded = eventWriter.getEvents(thread.id);
    expect(recorded.length).toBeGreaterThan(0);

    const seqs = recorded.map((r) => r.seq);
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(BigInt(i + 1));
    }
    expect(new Set(seqs.map((s) => s.toString())).size).toBe(seqs.length);
    expect(recorded.filter((r) => r.event.type === "turn.completed")).toHaveLength(2);
    expect(recorded.at(-1)?.event.type).toBe("turn.completed");
  });

  it("finalizes cancelled when signal is already aborted", async () => {
    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "hello",
        signal: controller.signal,
      }),
    );

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const assistantTurn = await repos.turns.findById(assistantCreated.turn.id);
    expect(assistantTurn?.status).toBe("cancelled");

    const cancelled = events.find((e) => e.type === "turn.cancelled");
    expect(cancelled?.type).toBe("turn.cancelled");

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("idle");
    expect(events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);

    const recorded = eventWriter.getEvents(thread.id);
    expect(recorded.some((r) => r.event.type === "turn.cancelled")).toBe(true);
    expect(recorded.at(-1)?.event.type).toBe("turn.cancelled");
  });

  it("finalizes error when tool-use loop exceeds the safety limit", async () => {
    let modelCalls = 0;
    const loopingGateway: Gateway = {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        modelCalls += 1;
        yield {
          type: "end",
          result: {
            content: [
              {
                type: "tool_use",
                toolCallId: `call-loop-${modelCalls}`,
                toolName: "loop_forever",
                input: {},
              },
            ],
            toolCalls: [],
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "stub-model",
            provider: "stub",
          },
        };
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in this test");
      },
    };
    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator(
      {
        executeTool: async (call) => ({ toolCallId: call.id, output: { ok: true } }),
      },
      loopingGateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "keep calling tools",
        tools: [
          {
            type: "function",
            name: "loop_forever",
            description: "Never reaches a terminal model response",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    expect(modelCalls).toBeGreaterThan(1);
    const assistantTurn = await repos.turns.findById(assistantCreated.turn.id);
    expect(assistantTurn?.status).toBe("error");
    expect(assistantTurn?.finishReason).toBe("error");
    expect(assistantTurn?.error).toContain("exceeded max tool iterations");

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("error");

    const recorded = eventWriter.getEvents(thread.id);
    expect(events.at(-1)?.type).toBe("turn.error");
    expect(recorded.at(-1)?.event.type).toBe("turn.error");
  });

  it("records gateway stream errors as MeridianError in turn.error", async () => {
    const failingGateway: Gateway = {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        yield {
          type: "error",
          code: "provider_error",
          message: "Upstream model failed",
          retryable: true,
        };
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in this test");
      },
    };

    const { repos, orchestrator, workbenchId } = await setupOrchestrator(undefined, failingGateway);
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });
    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "fail" }),
    );

    const turnError = events.find((event) => event.type === "turn.error");
    expect(turnError?.type).toBe("turn.error");
    if (turnError?.type === "turn.error") {
      expect(turnError.error).toEqual({
        code: "provider_error",
        message: "Upstream model failed",
        retryable: true,
        source: "gateway",
      });
    }
  });

  it("finalizes error on finishReason error from gateway", async () => {
    const errorGateway: Gateway = {
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "something went wrong" }],
            toolCalls: [],
            finishReason: "error",
            usage: { inputTokens: 10, outputTokens: 5 },
            model: "stub-model",
            provider: "stub",
          },
        };
      },
      async generate(_request: GenerateRequest) {
        throw new Error("not used in this test");
      },
    };

    const { repos, eventWriter, orchestrator, workbenchId } = await setupOrchestrator(
      undefined,
      errorGateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "trigger error",
      }),
    );

    const assistantCreated = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "turn.created" }> =>
        e.type === "turn.created" && e.turn.role === "assistant",
    );
    if (!assistantCreated) throw new Error("missing assistant turn");

    const assistantTurn = await repos.turns.findById(assistantCreated.turn.id);
    expect(assistantTurn?.status).toBe("error");
    expect(assistantTurn?.finishReason).toBe("error");

    const turnError = events.find((e) => e.type === "turn.error");
    expect(turnError?.type).toBe("turn.error");
    if (turnError?.type === "turn.error") {
      expect(turnError.error).toBeTruthy();
    }

    const threadAfter = await repos.threads.findById(thread.id);
    expect(threadAfter?.status).toBe("error");

    const recorded = eventWriter.getEvents(thread.id);
    expect(recorded.at(-1)?.event.type).toBe("turn.error");
  });
});
