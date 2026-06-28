/**
 * Runtime loop integration tests: exercise the orchestrator with in-memory
 * repositories, stub gateways, and real persistence projection so turn, block,
 * tool, permission, and journal behavior stay aligned across the loop boundary.
 */

import { EventType } from "@meridian/contracts/protocol";
import type { JsonValue, OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import { deriveJournalTurnId } from "../../../threads/domain/journal-turn-id.js";
import type { projectOrchestratorEvents } from "../../../threads/domain/orchestrator-event-projector.js";
import {
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  projectReadModelEvent,
} from "../../../threads/index.js";
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
import { gatewayStubDefaults } from "../../gateway/test-gateway.js";
import type { CheckpointToolHandlerContext, ToolExecutor, ToolHandler } from "../../tools/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createCheckpointRegistry } from "../checkpoints.js";
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
    projectPreferences?: Parameters<typeof createOrchestrator>[0]["projectPreferences"],
  ) {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    configureRepos?.(repos);
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
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
        projectPreferences: projectPreferences ?? {
          async read() {
            return { threadGroupBy: "work", pinnedThreadIds: [], defaultAgentSlug: null };
          },
        },
        creditLedger,
      }),
    );
    return { repos, eventWriter, orchestrator, projectId: project.id, checkpointRegistry };
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

  async function _readTurnLevelReadModel(repos: InMemoryThreadRepos, threadId: string) {
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

  async function _readThreadRow(repos: InMemoryThreadRepos, threadId: string) {
    const thread = await repos.threads.findById(threadId);
    if (!thread) throw new Error(`missing thread row: ${threadId}`);
    return thread;
  }

  async function _createEmptyReplayStoreFromThread(
    sourceRepos: InMemoryThreadRepos,
    threadId: string,
  ) {
    const sourceThread = await sourceRepos.threads.findById(threadId);
    if (!sourceThread) throw new Error("missing source thread");

    const projectRepo = createInMemoryProjectRepository();
    await projectRepo.create({
      id: sourceThread.projectId,
      userId: sourceThread.userId,
      title: "Replay Project",
    });
    const repos = createInMemoryRepositories({ projects: projectRepo });
    await repos.threads.create({
      id: sourceThread.id,
      userId: sourceThread.userId,
      projectId: sourceThread.projectId,
      title: sourceThread.title,
      systemPrompt: sourceThread.systemPrompt,
      workingState: sourceThread.workingState,
    });
    if (sourceThread.workId) {
      await repos.threadWorks.addMembership(sourceThread.id, sourceThread.workId, true);
    }
    return repos;
  }

  async function _replayJournalIntoStore(
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

  function _liveBlockSequencesFromAgui(agui: ReturnType<typeof projectOrchestratorEvents>) {
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
      ...gatewayStubDefaults,
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
      ...gatewayStubDefaults,
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

  function _createWeatherToolExecutor(): ToolExecutor {
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

  function _representativeToolGateway(): Gateway {
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
        },
        model: "stub-model",
        provider: "stub",
      },
    ]);
  }

  function _positionalTextResumeGateway(): Gateway {
    let call = 0;
    return {
      ...gatewayStubDefaults,
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

  function _positionalReasoningGateway(): Gateway {
    let call = 0;
    return {
      ...gatewayStubDefaults,
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
    const { repos, orchestrator, projectId } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", projectId });

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
    const { repos, orchestrator, projectId } = await setupOrchestrator(toolExecutor, gateway);
    const thread = await repos.threads.create({ userId: "user-1", projectId });

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

  it("suspends on a mock checkpoint without re-entering the gateway, then resumes on response", async () => {
    const gateway = checkpointGateway({ checkpointId: "checkpoint-user" });
    const { repos, eventWriter, orchestrator, projectId, checkpointRegistry } =
      await setupOrchestrator(createMockCheckpointToolExecutor(), gateway);
    const thread = await repos.threads.create({ userId: "user-1", projectId });
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

  it("finalizes cancelled when signal is already aborted", async () => {
    const { repos, eventWriter, orchestrator, projectId } = await setupOrchestrator();
    const thread = await repos.threads.create({ userId: "user-1", projectId });
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

  it("records gateway stream errors as MeridianError in turn.error", async () => {
    const failingGateway: Gateway = {
      ...gatewayStubDefaults,
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

    const { repos, orchestrator, projectId } = await setupOrchestrator(undefined, failingGateway);
    const thread = await repos.threads.create({ userId: "user-1", projectId });
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
});
