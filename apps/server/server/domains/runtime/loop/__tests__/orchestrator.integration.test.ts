/**
 * Runtime loop integration tests: exercise the orchestrator with in-memory
 * repositories, stub gateways, and real persistence projection so turn, block,
 * tool, permission, and journal behavior stay aligned across the loop boundary.
 */

import { modelResult } from "@meridian/agent-edit/integration";
import { EventType } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
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
import type {
  InterruptToolHandlerContext,
  ToolExecutor,
  ToolHandler,
  ToolHandlerContext,
} from "../../tools/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createInterruptRegistry } from "../interrupts.js";
import { createOrchestrator } from "../orchestrator.js";
import {
  computeEffectivePermissions,
  createPermissionGate,
  type PermissionGate,
  resolveProfile,
} from "../permissions/index.js";
import { createSystemUpdateDelivery } from "../system-update-delivery.js";
import { gatewayStubDefaults } from "./test-gateway.js";
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
    workWriteMode?: Parameters<typeof createOrchestrator>[0]["workWriteMode"],
    enableSystemUpdates = false,
    orchestratorOverrides: Partial<Parameters<typeof createOrchestrator>[0]> = {},
    systemUpdateDeliveryFactory?: (
      repos: ReturnType<typeof createInMemoryRepositories>,
      eventWriter: ReturnType<typeof createInMemoryEventJournalWriter>,
    ) => Parameters<typeof createOrchestrator>[0]["systemUpdateDelivery"],
  ) {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    configureRepos?.(repos);
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const eventWriter = createInMemoryEventJournalWriter();
    const systemUpdateDelivery = systemUpdateDeliveryFactory?.(repos, eventWriter);
    const interruptRegistry = createInterruptRegistry();
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
        interruptRegistry,
        permissionGate:
          permissionGate ??
          createPermissionGate(computeEffectivePermissions(resolveProfile("coding"))),
        projectPreferences: projectPreferences ?? {
          async read() {
            return { threadGroupBy: "work", pinnedThreadIds: [], defaultAgentSlug: null };
          },
        },
        ...(workWriteMode ? { workWriteMode } : {}),
        creditLedger,
        ...orchestratorOverrides,
        ...(systemUpdateDelivery ? { systemUpdateDelivery } : {}),
        ...(enableSystemUpdates
          ? {
              systemUpdateDelivery: createSystemUpdateDelivery({
                repos,
                eventWriter,
                workContext: {
                  async renderForThread() {
                    return "<work_context>\ncurrent: target-work\n</work_context>";
                  },
                },
                isThreadRunning: () => true,
                schedulePostCommit() {},
              }),
            }
          : {}),
      }),
    );
    return { repos, eventWriter, orchestrator, projectId: project.id, interruptRegistry };
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

  function getMockInterruptToolDefinition() {
    return {
      type: "function" as const,
      name: "mock_interrupt",
      description: "Mock interrupt",
      inputSchema: {
        type: "object",
        properties: {
          interruptId: { type: "string" },
          recommended: {},
          requiresHuman: { type: "boolean" },
          timeoutMs: { type: "number" },
        },
        required: ["interruptId"],
      },
    };
  }

  function createMockInterruptToolExecutor(): ToolExecutor {
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: getMockInterruptToolDefinition(),
      capability: "interrupt",
      execution: {
        type: "server",
        handler: (async (input, ctx) => {
          const args = input as {
            interruptId: string;
            recommended?: unknown;
            requiresHuman?: boolean;
            timeoutMs?: number;
          };
          const response = await ctx.interrupt(
            {
              interruptId: args.interruptId,
              prompt: "Mock interrupt",
              artifacts: [],
              answerSchema: { type: "object", properties: { value: { type: "string" } } },
              recommended: (args.recommended as JsonValue | undefined) ?? null,
              requiresHuman: args.requiresHuman ?? false,
            },
            args.timeoutMs ?? ctx.interruptTimeoutMs,
          );
          await ctx.updateComponentBlock(args.interruptId, {
            resolvedValue: response.value,
            answerProvenance: response.provenance,
          });
          return response;
        }) as ToolHandler<InterruptToolHandlerContext>,
      },
    });
    return createToolExecutor(registry);
  }

  function interruptGateway(input: {
    interruptId: string;
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
                  toolCallId: "call-interrupt",
                  toolName: "mock_interrupt",
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

  it("freezes the Work write mode on the assistant turn at creation", async () => {
    const { repos, orchestrator, projectId } = await setupOrchestrator(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { read: async () => "draft" },
    );
    const thread = await repos.threads.create({ userId: "user-1", projectId });
    await repos.threadWorks.addMembership(thread.id, "00000000-0000-4000-8000-000000000001", true);

    const handle = await orchestrator.runTurn({ threadId: thread.id, userText: "draft this" });
    const turns = await repos.turns.listByThread(thread.id);

    expect(turns.map(({ role, writeMode }) => ({ role, writeMode }))).toEqual([
      { role: "user", writeMode: null },
      { role: "assistant", writeMode: "draft" },
    ]);
    await collectEvents(handle);
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

  it.each([
    ["switch", "primary", false],
    ["switch", "subagent", true],
    ["create", "primary", false],
    ["update", "primary", false],
    ["delete", "primary", false],
  ] as const)("injects a %s Work update before the next %s model call", async (command, _kind, isSubagentThread) => {
    const requests: GenerateRequest[] = [];
    const results: GenerateResult[] = [
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-switch",
            toolName: "work",
            input: { command, work: "target-work" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "continued" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ];
    let resultIndex = 0;
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request) {
        requests.push(request);
        const result = results[resultIndex++];
        if (!result) throw new Error("unexpected model call");
        yield { type: "end", result };
      },
      async generate() {
        throw new Error("unused");
      },
    };
    const registry = createToolRegistry();
    const workTool = {
      type: "function" as const,
      name: "work",
      description: "Work",
      inputSchema: { type: "object" as const },
    };
    let enqueueWorkContext = async (_threadId: ThreadId) => {};
    registry.register({
      source: "core",
      definition: workTool,
      execution: {
        type: "server",
        handler: async (_input: unknown, ctx: ToolHandlerContext) => {
          await enqueueWorkContext(ctx.threadId);
          return {
            output: { slug: "target-work" },
            metadata: { workContextChanged: true },
          };
        },
      },
    });
    const { repos, orchestrator, projectId } = await setupOrchestrator(
      createToolExecutor(registry),
      gateway,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    enqueueWorkContext = (threadId) =>
      repos.workContextDeliveries.enqueueThread(threadId).then(() => undefined);
    const thread = await repos.threads.create({ userId: "user-1", projectId });
    await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "switch",
        tools: [workTool],
        isSubagentThread,
      }),
    );

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("current: target-work");
    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.some((turn) => JSON.stringify(turn.metadata).includes("system_update"))).toBe(
      true,
    );
  });

  it("settles staged writes before switching and rotates the post-switch edit scope", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          { type: "tool_use", toolCallId: "write-1", toolName: "mock_write", input: {} },
          {
            type: "tool_use",
            toolCallId: "switch-1",
            toolName: "work",
            input: { command: "switch", work: "target" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "tool_use", toolCallId: "write-2", toolName: "mock_write", input: {} }],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "done" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    let currentWork = "source";
    let writeIndex = 0;
    const registry = createToolRegistry();
    for (const [name, handler] of [
      [
        "mock_write",
        async () => {
          writeIndex += 1;
          return {
            output: { ok: true },
            metadata: {
              stagedWrite: true,
              documentId: `doc-${writeIndex}`,
              writeId: `write-${writeIndex}`,
              settlementId: `settlement-${writeIndex}`,
            },
          };
        },
      ],
      [
        "work",
        async () => {
          currentWork = "target";
          return { output: { slug: "target" }, metadata: { workContextChanged: true } };
        },
      ],
    ] as const) {
      registry.register({
        source: "core",
        definition: { type: "function", name, description: name, inputSchema: { type: "object" } },
        execution: { type: "server", handler },
      });
    }
    const settlements: Array<{ responseId: string; work: string }> = [];
    const { repos, orchestrator, projectId } = await setupOrchestrator(
      createToolExecutor(registry),
      gateway,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      {
        responseWrites: {
          async commitResponse(responseId, _ctx, beforeCommit) {
            settlements.push({ responseId, work: currentWork });
            const result = {
              status: "committed" as const,
              receipts:
                currentWork === "source" || writeIndex >= 2
                  ? [
                      {
                        documentId: currentWork === "source" ? "doc-1" : "doc-2",
                        receipt: {
                          writeId: currentWork === "source" ? "write-1" : "write-2",
                          settlementId: currentWork === "source" ? "settlement-1" : "settlement-2",
                          result: modelResult({
                            command: "insert",
                            status: "success",
                            phase: "committed",
                            payload: {
                              write: { id: currentWork === "source" ? "write-1" : "write-2" },
                            },
                          }),
                        },
                      },
                    ]
                  : [],
              concurrentEdits: [],
            };
            await beforeCommit(result);
            return result;
          },
          async rollbackResponse() {},
        },
      },
    );
    const thread = await repos.threads.create({ userId: "user-1", projectId });
    await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "write then switch" }),
    );

    expect(settlements.map(({ work }) => work)).toEqual(["source", "target", "target"]);
    expect(settlements[0]?.responseId).not.toBe(settlements[1]?.responseId);
    expect(settlements[1]?.responseId).not.toBe(settlements[2]?.responseId);
  });

  it("persists pending Work context delivery and recovers it at the turn boundary", async () => {
    const requests: GenerateRequest[] = [];
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "switch-pending",
            toolName: "work",
            input: { command: "switch", work: "target" },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "continued with pending context" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const capturingGateway: Gateway = {
      ...gateway,
      async *stream(request) {
        requests.push(request);
        yield* gateway.stream(request);
      },
    };
    const workReceipt = {
      operation: "switch",
      category: "binding",
      changed: true,
      workId: "work-target",
      workName: "Target",
      before: null,
      after: null,
      inverse: { command: "switch", workId: "work-source" },
    } as const;
    const registry = createToolRegistry();
    let enqueueWorkContext = async (_threadId: ThreadId) => {};
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "work",
        description: "Work",
        inputSchema: { type: "object" },
      },
      execution: {
        type: "server",
        handler: async (_input: unknown, ctx: ToolHandlerContext) => {
          await enqueueWorkContext(ctx.threadId);
          return {
            output: { slug: "target" },
            metadata: { workContextChanged: true, workReceipt },
          };
        },
      },
    });
    let running = true;
    let delivery: ReturnType<typeof createSystemUpdateDelivery> | undefined;
    const { repos, eventWriter, orchestrator, projectId } = await setupOrchestrator(
      createToolExecutor(registry),
      capturingGateway,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      {},
      (deliveryRepos, deliveryWriter) => {
        const actual = createSystemUpdateDelivery({
          repos: deliveryRepos,
          eventWriter: deliveryWriter,
          workContext: {
            async renderForThread() {
              return "<work_context>current: target</work_context>";
            },
          },
          isThreadRunning: () => running,
          schedulePostCommit() {},
        });
        delivery = actual;
        return {
          ...actual,
          async deliverNow() {
            throw new Error("Work context update exhausted 3 CAS retries");
          },
        };
      },
    );
    enqueueWorkContext = (threadId) =>
      repos.workContextDeliveries.enqueueThread(threadId).then(() => undefined);
    const thread = await repos.threads.create({ userId: "user-1", projectId });
    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "switch" }),
    );

    const pending = {
      contextUpdate: {
        status: "pending",
        message: "Work context update exhausted 3 CAS retries",
      },
    };
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain('"status":"pending"');
    const toolResultEvents = events.filter(
      (event): event is Extract<OrchestratorEvent, { type: "tool.result" }> =>
        event.type === "tool.result" && event.toolCallId === "switch-pending",
    );
    expect(toolResultEvents.at(-1)?.output).toMatchObject(pending);
    const blocks = await repos.blocks.listByThread(thread.id);
    expect(blocks.find((block) => block.blockType === "tool_result")?.content).toMatchObject({
      output: pending,
      metadata: { workContextDelivery: "pending", workReceipt },
    });
    const replay = await eventWriter.readAfter(thread.id, 0n);
    const replayedResult = replay
      .map((entry) => entry.payload)
      .filter(
        (event): event is Extract<OrchestratorEvent, { type: "tool.result" }> =>
          event.type === "tool.result" && event.toolCallId === "switch-pending",
      )
      .at(-1);
    expect(replayedResult?.output).toMatchObject(pending);
    expect(replayedResult?.metadata).toMatchObject({ workReceipt });

    running = false;
    if (!delivery) throw new Error("System update delivery was not composed");
    await delivery.flush(thread.id);
    const recoveredTurns = await repos.turns.listByThread(thread.id);
    expect(recoveredTurns.at(-1)?.metadata).toMatchObject({
      kind: "system_update",
      section: "work_context",
    });
    const recoveredResult = (await repos.blocks.listByThread(thread.id)).find(
      (block) => block.blockType === "tool_result",
    );
    expect(recoveredResult?.content).toMatchObject({
      output: { slug: "target" },
      metadata: { workContextDelivery: "delivered", workReceipt },
    });
    expect(JSON.stringify(recoveredResult?.content)).not.toContain('"status":"pending"');
    const recoveredReplay = await eventWriter.readAfter(thread.id, 0n);
    const acknowledgedResult = recoveredReplay
      .map((entry) => entry.payload)
      .filter(
        (event): event is Extract<OrchestratorEvent, { type: "tool.result" }> =>
          event.type === "tool.result" && event.toolCallId === "switch-pending",
      )
      .at(-1);
    expect(acknowledgedResult).toMatchObject({
      output: { slug: "target" },
      metadata: { workContextDelivery: "delivered", workReceipt },
    });
  });

  it("suspends on a mock interrupt without re-entering the gateway, then resumes on response", async () => {
    const gateway = interruptGateway({ interruptId: "interrupt-user" });
    const { repos, eventWriter, orchestrator, projectId, interruptRegistry } =
      await setupOrchestrator(createMockInterruptToolExecutor(), gateway);
    const thread = await repos.threads.create({ userId: "user-1", projectId });
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "pause",
      tools: [getMockInterruptToolDefinition()],
    });
    const eventsPromise = collectEvents(handle);

    await waitForJournalEvent(eventWriter, thread.id, "interrupt.created");

    const interruptCreated = eventWriter
      .getEvents(thread.id)
      .map((entry) => entry.event)
      .find((event) => event.type === "interrupt.created");
    expect(interruptCreated?.type).toBe("interrupt.created");
    if (interruptCreated?.type === "interrupt.created") {
      expect(interruptCreated.request).toMatchObject({
        interruptId: "interrupt-user",
        answerSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      });
    }
    const assistantTurnId =
      interruptCreated?.type === "interrupt.created" ? interruptCreated.turnId : "";
    const waitingTurn = await repos.turns.findById(assistantTurnId);
    expect(waitingTurn?.status).toBe("waiting_interrupt");
    expect(gateway.getCallCount()).toBe(1);

    expect(
      interruptRegistry.resolve({
        threadId: thread.id,
        turnId: assistantTurnId,
        interruptId: "interrupt-user",
        value: { value: "approved" },
      }),
    ).toEqual({ ok: true });

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "interrupt.resolved")).toBe(true);
    expect(gateway.getCallCount()).toBe(2);

    const blocks = await repos.blocks.listByTurn(assistantTurnId);
    const toolResult = blocks.find((block) => block.blockType === "tool_result");
    expect(toolResult?.content).toMatchObject({
      toolCallId: "call-interrupt",
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
