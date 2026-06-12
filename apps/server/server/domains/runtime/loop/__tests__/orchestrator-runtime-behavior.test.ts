// @ts-nocheck
/**
 * Runtime orchestrator behavior tests: verify turn setup, gateway handoff,
 * cancellation, and tool dispatch boundaries without involving real providers.
 */
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import { createInMemoryWorkbenchRepository } from "../../../workbenches/index.js";
import type { Gateway, GenerateRequest, GenerateResult, StreamEvent } from "../../gateway/index.js";
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
  const workbenchRepo = createInMemoryWorkbenchRepository();
  const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
  const workbench = await workbenchRepo.create({ userId: "user-1", title: "Test Workbench" });
  const eventWriter = createInMemoryEventJournalWriter();
  const checkpointRegistry = createCheckpointRegistry();
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
        executeTool: async (call) => ({ toolCallId: call.id, output: { ok: true } }),
      },
      repos,
      eventWriter,
      checkpointRegistry,
      creditLedger,
    }),
  );
  return { repos, eventWriter, orchestrator, workbenchId: workbench.id };
}

function runnableCoreRegistrations() {
  const handler = async () => ({ ok: true });
  return createCoreToolRegistrations({
    read: handler,
    edit: handler,
    write: handler,
    list: handler,
    search: handler,
    ask_user: handler,
    bash: handler,
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
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "Test Workbench" });
    const thread = await repos.threads.create({ userId: "user-1", workbenchId: workbench.id });
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
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(toolExecutor, gateway);
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

    await collectEvents(await orchestrator.runTurn({ threadId: thread.id, userText: "hello" }));

    expect(requestTools?.map((tool) => (tool.type === "function" ? tool.name : tool.kind))).toEqual(
      [...CORE_TOOL_NAMES],
    );
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
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "Test Workbench" });
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
      workbenchId: workbench.id,
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
    const thread = await repos.threads.create({ userId: "user-1", workbenchId: workbench.id });

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
    const { repos, orchestrator, workbenchId } = await setupOrchestrator(
      createToolExecutor(registry),
      gateway,
    );
    const thread = await repos.threads.create({ userId: "user-1", workbenchId });

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
});
