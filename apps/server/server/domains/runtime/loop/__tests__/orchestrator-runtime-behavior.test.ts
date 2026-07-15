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
import { createInterruptRegistry } from "../interrupts.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTestNoticePort, createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

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
  const interruptRegistry = createInterruptRegistry();
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
        executeTool: async (call) => ({ toolCallId: call.id, output: { ok: true } }),
      },
      repos,
      eventWriter,
      interruptRegistry,
      creditLedger,
    }),
  );
  return { repos, eventWriter, orchestrator, projectId: project.id };
}

function runnableCoreRegistrations() {
  const handler = async () => ({ ok: true });
  return createCoreToolRegistrations({
    write: handler,
    ls: handler,
    grep: handler,
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
        interruptRegistry: createInterruptRegistry(),
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
      interruptRegistry: createInterruptRegistry(),
      toolExecutor: {
        executeTool: async (call) => ({ toolCallId: call.id, output: "staged write" }),
      },
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return { status: "committed", concurrentEdits: [] };
        },
        async rollbackResponse() {},
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
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

  it("backfills rendered concurrent edit blocks into the next tool result", async () => {
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
            content: [{ type: "text", text: "saw concurrent blocks" }],
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
    const deps = createTestOrchestratorDeps({
      gateway,
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger: createInMemoryCreditLedger(),
      interruptRegistry: createInterruptRegistry(),
      toolExecutor: {
        executeTool: async (call) => ({
          toolCallId: call.id,
          output: [{ type: "text", text: "status: success" }],
          metadata: { documentId: "doc-1" },
        }),
      },
      responseWrites: {
        async commitResponse() {
          return {
            status: "committed" as const,
            concurrentEdits: [
              {
                documentId: "doc-1",
                concurrentEdits: {
                  human: ["abcd"],
                  agent: [],
                  renderedBlocks: { human: ["abcd|Human changed line."], agent: [] },
                },
              },
            ],
          };
        },
        async rollbackResponse() {},
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "edit chapter" }),
    );

    const secondRequest = JSON.stringify(requests[1]?.messages);
    expect(secondRequest).toContain("concurrent edits:\\n  human: abcd");
    expect(secondRequest).toContain("current blocks:");
    expect(secondRequest).toContain("abcd|Human changed line.");
  });

  it("drains undo and newly recorded late-sweep notices before each model call", async () => {
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
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const notices = createTestNoticePort([
      {
        id: 1,
        kind: "undo",
        scope: { kind: "thread", threadId: thread.id },
        message: "",
        data: {
          writeHandles: ["w1"],
          uri: "manuscript://chapter-1.md",
          direction: "undo",
        },
        writerVisible: false,
        createdAt: new Date("2026-06-27T00:00:00.000Z"),
      },
    ]);
    let drainCount = 0;
    const drain = notices.drainForModelContext.bind(notices);
    notices.drainForModelContext = async (threadId, activeDocumentIds) => {
      drainCount += 1;
      return drain(threadId, activeDocumentIds);
    };
    const deps = createTestOrchestratorDeps({
      gateway,
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger,
      interruptRegistry: createInterruptRegistry(),
      toolExecutor: {
        executeTool: async (call) => ({ toolCallId: call.id, output: "tool result" }),
      },
      responseWrites: {
        async commitResponse() {
          await notices.record({
            kind: "late_sweep",
            scope: { kind: "thread", threadId: thread.id },
            message: "Content was modified — View change",
            data: {
              documentId: "00000000-0000-4000-8000-000000000002",
              documentName: "chapter-2.md",
              affectedBlockHashes: ["hash-swept"],
              capturedDeletedBodies: [{ hash: "hash-swept", body: "Writer body." }],
              beforeContentRef: 42,
            },
            writerVisible: true,
          });
          return { status: "committed", concurrentEdits: [] };
        },
        async rollbackResponse() {},
      },
      notices,
    });

    await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "continue" }),
    );

    expect(drainCount).toBe(2);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "The writer reversed the following edits before this message",
    );
    expect(JSON.stringify(requests[1]?.messages)).toContain("Before-state journal reference: 42");
    expect(JSON.stringify(requests[1]?.messages)).toContain("hash-swept|Writer body.");
  });

  it("does not let debug capture failure prevent a notice-bearing model call", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    let drainCount = 0;
    const deps = createTestOrchestratorDeps({
      gateway: textGateway(),
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger,
      interruptRegistry: createInterruptRegistry(),
      notices: {
        ...createTestNoticePort(),
        async drainForModelContext() {
          drainCount += 1;
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

    expect(drainCount).toBe(1);
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
        interruptRegistry: createInterruptRegistry(),
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

  it("ends the turn cleanly when response commit reports a closed draft", async () => {
    const requests: GenerateRequest[] = [];
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        requests.push(request);
        yield {
          type: "end",
          result: {
            content: [{ type: "tool_use", toolCallId: "call-write", toolName: "write", input: {} }],
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
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    const committed: string[] = [];
    const deps = createTestOrchestratorDeps({
      gateway,
      toolExecutor: {
        executeTool: async (call) => ({ toolCallId: call.id, output: "staged write" }),
      },
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger: createInMemoryCreditLedger(),
      interruptRegistry: createInterruptRegistry(),
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return { status: "draft_closed", responseId, mode: "draft" };
        },
        async rollbackResponse() {},
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const events = await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "edit chapter" }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[1]).toBeUndefined();
    expect(committed).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(events.some((event) => event.type === "turn.error")).toBe(false);
    await expect(repos.threads.findById(thread.id)).resolves.toMatchObject({ status: "idle" });
  });

  it("delivers a rejected commit notice without persisting a turn or changing logical head", async () => {
    const requests: GenerateRequest[] = [];
    const gateway = gatewayFromResults([
      {
        content: [
          { type: "tool_use", toolCallId: "write-a", toolName: "write", input: {} },
          { type: "tool_use", toolCallId: "write-b", toolName: "write", input: {} },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [
          { type: "tool_use", toolCallId: "read-after-reject", toolName: "read", input: {} },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [
          { type: "tool_use", toolCallId: "write-after-read", toolName: "write", input: {} },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
      {
        content: [{ type: "text", text: "retry committed" }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "stub-model",
        provider: "stub",
      },
    ]);
    const recordingGateway: Gateway = {
      ...gateway,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        requests.push(request);
        yield* gateway.stream(request);
      },
    };
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Test Project" });
    let commitCount = 0;
    let headAtRejection: string | null | undefined;
    const deps = createTestOrchestratorDeps({
      gateway: recordingGateway,
      repos,
      eventWriter: createInMemoryEventJournalWriter(),
      creditLedger: createInMemoryCreditLedger(),
      interruptRegistry: createInterruptRegistry(),
      toolExecutor: {
        async executeTool(call) {
          if (call.name === "read") {
            return { toolCallId: call.id, output: "current document" };
          }
          return { toolCallId: call.id, output: "staged write" };
        },
      },
      responseWrites: {
        async commitResponse(responseId) {
          commitCount += 1;
          if (commitCount === 1) {
            headAtRejection = (await repos.threads.findById(thread.id))?.activeLeafTurnId;
            return {
              status: "rejected",
              responseId,
              rejections: [
                {
                  documentId: "chapter-one.md",
                  conflictedBlockHashes: ["hash-a", "hash-b"],
                  affectedWriteIds: ["write-a", "write-b"],
                },
                {
                  documentId: "chapter-two.md",
                  conflictedBlockHashes: [],
                  affectedWriteIds: [],
                },
              ],
            };
          }
          return { status: "committed", concurrentEdits: [] };
        },
        async rollbackResponse() {},
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });

    const events = await collectEvents(
      await createOrchestrator(deps).runTurn({ threadId: thread.id, userText: "edit chapter" }),
    );

    const postRejectionMessages = requests[1]?.messages ?? [];
    const stagedResults = postRejectionMessages.filter((message) => message.role === "tool");
    const noticeIndex = postRejectionMessages.findIndex(
      (message) =>
        message.role === "system" &&
        JSON.stringify(message.content).includes("superseded and void"),
    );
    expect(stagedResults).toHaveLength(2);
    expect(
      stagedResults.every((message) => !JSON.stringify(message.content).includes('"isError":true')),
    ).toBe(true);
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(postRejectionMessages[noticeIndex])).toContain("chapter-one.md");
    expect(JSON.stringify(postRejectionMessages[noticeIndex])).toContain("chapter-two.md");
    expect(JSON.stringify(postRejectionMessages[noticeIndex])).toContain("write-a");
    expect(JSON.stringify(postRejectionMessages[noticeIndex])).toContain("write-b");
    expect(JSON.stringify(postRejectionMessages[noticeIndex])).toContain("hash-a");
    expect(JSON.stringify(postRejectionMessages[noticeIndex])).toContain("hash-b");

    const turns = await repos.turns.listByThread(thread.id);
    const rejectionTurn = turns.find((turn) => turn.role === "system");
    expect(rejectionTurn).toBeUndefined();
    const updatedThread = await repos.threads.findById(thread.id);
    expect(updatedThread?.activeLeafTurnId).toBe(headAtRejection);
    expect(turns.find((turn) => turn.id === updatedThread?.activeLeafTurnId)?.role).toBe(
      "assistant",
    );
    expect(
      requests[2]?.messages.some((message) =>
        JSON.stringify(message).includes("read-after-reject"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "turn.error")).toBe(false);
    expect(commitCount).toBe(3);
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
      interruptRegistry: createInterruptRegistry(),
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return { status: "committed", concurrentEdits: [] };
        },
        async rollbackResponse(responseId) {
          rolledBack.push(responseId);
        },
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
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
      interruptRegistry: createInterruptRegistry(),
      responseWrites: {
        async commitResponse(responseId) {
          committed.push(responseId);
          return { status: "committed", concurrentEdits: [] };
        },
        async rollbackResponse(responseId) {
          rolledBack.push(responseId);
        },
      },
    });
    await deps.creditLedger.grant({
      userId: "user-1",
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
