/**
 * Runtime orchestrator behavior tests: verify turn setup, gateway handoff,
 * cancellation, and tool dispatch boundaries without involving real providers.
 */
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import type { Gateway, GenerateRequest, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { gatewayStubDefaults } from "../../gateway/test-gateway.js";
import {
  CORE_TOOL_NAMES,
  createCoreToolRegistrations,
  createToolExecutor,
  createToolRegistry,
  type ToolExecutor,
  type ToolHandlerContext,
} from "../../tools/index.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

function gatewayFromResults(results: GenerateResult[]): Gateway {
  let index = 0;
  return {
    ...gatewayStubDefaults,
    async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
      const result = results[index++];
      if (!result) throw new Error(`No stubbed result for model call ${index}`);
      yield { type: "end", result };
    },
    async generate(_request: GenerateRequest) {
      throw new Error("not used in these tests");
    },
  };
}

function textGateway(): Gateway {
  return gatewayFromResults([
    {
      content: [{ type: "text", text: "done" }],
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "stub-model",
      provider: "stub",
    },
  ]);
}

async function setupOrchestrator(toolExecutor?: ToolExecutor, gateway: Gateway = textGateway()) {
  const projectRepo = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects: projectRepo });
  const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
  const eventWriter = createInMemoryEventJournalWriter();
  const checkpointRegistry = createCheckpointRegistry();
  const creditLedger = createInMemoryCreditLedger();
  await creditLedger.grant({
    userId: "user-1",
    projectId: project.id,
    source: "manual",
    amountMillicredits: "1000000000",
    reason: "test",
  });
  const orchestrator = createOrchestrator(
    createTestOrchestratorDeps({
      gateway,
      toolExecutor: toolExecutor ?? {
        executeTool: async (call) => ({ toolCallId: call.id, output: { ok: true } }),
      },
      repos,
      eventWriter,
      checkpointRegistry,
      creditLedger,
    }),
  );
  return { repos, eventWriter, orchestrator, projectId: project.id };
}

function runnableCoreRegistrations() {
  const handler = async () => ({ ok: true });
  return createCoreToolRegistrations({
    write: handler,
    list: handler,
    search: handler,
    ask_user: handler,
  });
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

describe("runtime orchestrator behavior", () => {
  it("rolls back turn setup when journaling fails", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway: textGateway(),
        toolExecutor: {
          executeTool: async (call) => ({ toolCallId: call.id, output: { ok: true } }),
        },
        repos,
        eventWriter: {
          appendEvent: async () => {
            throw new Error("journal unavailable");
          },
        },
        checkpointRegistry: createCheckpointRegistry(),
        creditLedger,
      }),
    );

    await expect(orchestrator.runTurn({ threadId: thread.id, userText: "hello" })).rejects.toThrow(
      "journal unavailable",
    );

    await expect(repos.turns.listByThread(thread.id)).resolves.toEqual([]);
    await expect(repos.blocks.listByThread(thread.id)).resolves.toEqual([]);
    await expect(repos.threads.findById(thread.id)).resolves.toMatchObject({ status: "idle" });
  });

  it("passes registry tool definitions to the gateway when run input omits tools", async () => {
    let requestTools: GenerateRequest["tools"];
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        requestTools = request.tools;
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "ready" }],
            toolCalls: [],
            finishReason: "end_turn",
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
    const toolExecutor = createToolExecutor(
      createToolRegistry({ registrations: runnableCoreRegistrations() }),
    );
    const { repos, orchestrator, projectId } = await setupOrchestrator(toolExecutor, gateway);
    const thread = await repos.threads.create({ userId: "user-1", projectId });

    await collectEvents(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requestTools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind))).toEqual(
      [...CORE_TOOL_NAMES],
    );
  });

  it("commits response without creating echo system turn", async () => {
    const requests: GenerateRequest[] = [];
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: "end",
            result: {
              content: [
                { type: "tool_use", toolCallId: "call-write", toolName: "write", input: {} },
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
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "continued without sync echo" }],
            toolCalls: [],
            finishReason: "end_turn",
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
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const committed: string[] = [];
    const deps = createTestOrchestratorDeps({
      gateway,
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger: createInMemoryCreditLedger(),
      checkpointRegistry: createCheckpointRegistry(),
      toolExecutor: {
        executeTool: async (call) => ({ toolCallId: call.id, output: "staged write" }),
      },
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return [];
        },
        async rollbackResponse() {},
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const events = await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "edit chapter" }),
    );

    expect(requests).toHaveLength(2);
    expect(committed).toHaveLength(1);
    const secondRequestSystemMessages = requests[1]?.messages.filter(
      (message) => message.role === "system",
    );
    expect(JSON.stringify(secondRequestSystemMessages)).not.toContain("concurrent edits");
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "turn.created",
        turn: expect.objectContaining({ role: "system" }),
      }),
    );
  });

  it("injects consumed undo notifications only on the first model call", async () => {
    const requests: GenerateRequest[] = [];
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: "end",
            result: {
              content: [
                { type: "tool_use", toolCallId: "call-write", toolName: "write", input: {} },
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
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "done" }],
            toolCalls: [],
            finishReason: "end_turn",
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
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    let consumeCount = 0;
    const deps = createTestOrchestratorDeps({
      gateway,
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger,
      checkpointRegistry: createCheckpointRegistry(),
      toolExecutor: {
        executeTool: async (call) => ({ toolCallId: call.id, output: "tool result" }),
      },
      undoNotifications: {
        async record() {},
        async consumeForThread(threadId) {
          consumeCount += 1;
          return [
            {
              id: "notification-1",
              threadId: threadId as never,
              writeHandle: "w1",
              turnId: "00000000-0000-4000-8000-000000000001" as never,
              uri: "manuscript://chapter-1.md",
              direction: "undo",
              createdAt: new Date("2026-06-27T00:00:00.000Z"),
            },
          ];
        },
      },
    });

    await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "continue" }),
    );

    expect(consumeCount).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "The writer reversed the following edits before this message",
    );
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(
      "The writer reversed the following edits before this message",
    );
  });

  it("keeps pending undo notifications when the first model call is not issued", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    let consumeCount = 0;
    const deps = createTestOrchestratorDeps({
      gateway: textGateway(),
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger,
      checkpointRegistry: createCheckpointRegistry(),
      undoNotifications: {
        async record() {},
        async consumeForThread() {
          consumeCount += 1;
          return [];
        },
      },
      modelRequestDebug: {
        captureEnabled: true,
        record() {
          throw new Error("debug store unavailable before gateway stream");
        },
        listByTurn() {
          return [];
        },
        listByThread() {
          return [];
        },
      },
    });

    await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "continue" }),
    );

    expect(consumeCount).toBe(0);
  });

  it("does not invoke a tool when cancelled while emitting tool.executing", async () => {
    const gateway = gatewayFromResults([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-cancel-window",
            toolName: "cancel_window_tool",
            input: {},
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const controller = new AbortController();
    const baseWriter = createInMemoryEventJournalWriter();
    const eventWriter = {
      appendEvent: async (threadId: string, event: OrchestratorEvent) => {
        const seq = await baseWriter.appendEvent(threadId, event);
        if (event.type === "tool.executing") controller.abort();
        return seq;
      },
    };
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    let executeCalled = false;
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        toolExecutor: {
          executeTool: async (call) => {
            executeCalled = true;
            return { toolCallId: call.id, output: "should not run" };
          },
        },
        repos,
        eventWriter,
        checkpointRegistry: createCheckpointRegistry(),
        creditLedger,
      }),
    );
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "cancel before tool",
        tools: [
          {
            type: "function",
            name: "cancel_window_tool",
            description: "Cancel window tool",
            inputSchema: { type: "object" },
          },
        ],
        signal: controller.signal,
      }),
    );

    expect(executeCalled).toBe(false);
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
    expect(events.some((event) => event.type === "tool.result")).toBe(false);
  });

  it("finalizes cancellation promptly while a tool call is in flight", async () => {
    const gateway = gatewayFromResults([
      {
        content: [{ type: "tool_use", toolCallId: "call-slow", toolName: "slow_tool", input: {} }],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    let handlerSawAbort = false;
    const registry = createToolRegistry();
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "slow_tool",
        description: "Slow tool",
        inputSchema: { type: "object" },
      },
      execution: {
        type: "server",
        handler: async (_input: unknown, { signal }: ToolHandlerContext) => {
          handlerStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                handlerSawAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          return "late result";
        },
      },
    });
    const controller = new AbortController();
    const { repos, orchestrator, projectId } = await setupOrchestrator(
      createToolExecutor(registry),
      gateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", projectId });

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "run slow tool",
      tools: registry.getDefinitions(),
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await started;
    controller.abort();
    const events = await eventsPromise;

    expect(handlerSawAbort).toBe(true);
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
    expect(events.some((event) => event.type === "tool.result")).toBe(false);
  });

  it("rolls back the active response when tool dispatch throws", async () => {
    const gateway = gatewayFromResults([
      {
        content: [{ type: "tool_use", toolCallId: "call-write", toolName: "write", input: {} }],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const rolledBack: string[] = [];
    const committed: string[] = [];
    let responseIdSeenByTool: string | undefined;
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const deps = createTestOrchestratorDeps({
      gateway,
      toolExecutor: {
        executeTool: async (_call, ctx) => {
          responseIdSeenByTool = ctx.responseId;
          throw new Error("tool crashed after staging a write");
        },
      },
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger: createInMemoryCreditLedger(),
      checkpointRegistry: createCheckpointRegistry(),
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return [];
        },
        async rollbackResponse(responseId) {
          rolledBack.push(responseId);
        },
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const guardedOrchestrator = createOrchestrator(deps);
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const events = await collectEvents(
      await guardedOrchestrator.runTurn({
        threadId: thread.id,
        userText: "write then crash",
        tools: [
          {
            type: "function",
            name: "write",
            description: "Write",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(responseIdSeenByTool).toBeDefined();
    expect(rolledBack).toEqual([responseIdSeenByTool]);
    expect(committed).toEqual([]);
    expect(events.some((event) => event.type === "turn.error")).toBe(true);
  });

  it("rolls back when cancellation arrives after the final tool result but before response commit", async () => {
    const gateway = gatewayFromResults([
      {
        content: [{ type: "tool_use", toolCallId: "call-write", toolName: "write", input: {} }],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const rolledBack: string[] = [];
    const committed: string[] = [];
    let responseIdSeenByTool: string | undefined;
    let toolFinished = false;
    let postToolAbortReads = 0;
    const signal = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      get aborted() {
        if (!toolFinished) return false;
        postToolAbortReads += 1;
        return postToolAbortReads >= 3;
      },
    } as unknown as AbortSignal;
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const deps = createTestOrchestratorDeps({
      gateway,
      toolExecutor: {
        executeTool: async (_call, ctx) => {
          responseIdSeenByTool = ctx.responseId;
          toolFinished = true;
          return { toolCallId: "call-write", output: "staged" };
        },
      },
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger: createInMemoryCreditLedger(),
      checkpointRegistry: createCheckpointRegistry(),
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return [];
        },
        async rollbackResponse(responseId) {
          rolledBack.push(responseId);
        },
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const guardedOrchestrator = createOrchestrator(deps);
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const events = await collectEvents(
      await guardedOrchestrator.runTurn({
        threadId: thread.id,
        userText: "write then cancel",
        tools: [
          {
            type: "function",
            name: "write",
            description: "Write",
            inputSchema: { type: "object" },
          },
        ],
        signal,
      }),
    );

    expect(responseIdSeenByTool).toBeDefined();
    expect(committed).toEqual([]);
    expect(rolledBack).toEqual([responseIdSeenByTool]);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
  });
});
