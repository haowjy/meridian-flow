/**
 * P2b nested-run gate: spawn → child return_result → parent checkpoint →
 * resume same root turn → re-spawn → completed; depth/budget/cancel guards.
 */

import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { JsonValue, OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import type {
  AgentDefinitionRecord,
  PackageInstallRecord,
} from "../../../packages/domain/types.js";
import { createInMemoryPackageStore } from "../../../packages/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
} from "../../../threads/index.js";
import {
  createMockOpenAICompatibleServer,
  type Gateway,
  type GenerateRequest,
  type GenerateResult,
  type MockOpenAIServer,
  type StreamEvent,
} from "../../gateway/index.js";
import { createChildRunCoordinator } from "../../spawn/child-run-coordinator.js";
import { createHelperResultDelivery } from "../../spawn/helper-result-delivery.js";
import {
  type CheckpointToolHandlerContext,
  createToolExecutor,
  createToolRegistry,
  type ToolHandler,
} from "../../tools/index.js";
import { createSpawnToolRegistrations } from "../../tools/spawn-tools.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTurnRunner } from "../turn-runner.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

describe("nested spawn runtime (P2b gate)", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  function seedOrchestratorPackage(projectId: string) {
    const pkg: PackageInstallRecord = {
      id: "pkg-1",
      projectId,
      packageName: "pilot",
      sourcePath: "/pilot",
      visibility: "private",
    };
    const orchestrator: AgentDefinitionRecord = {
      id: "agent-orchestrator",
      projectId,
      slug: "orchestrator",
      body: "You orchestrate workers.",
      meta: { subagents: ["worker"] },
      config: {},
      packageInstallId: pkg.id,
      originalContentChecksum: null,
      sourceType: "package",
      enabled: true,
    };
    const worker: AgentDefinitionRecord = {
      id: "agent-worker",
      projectId,
      slug: "worker",
      body: "You are a worker.",
      meta: { subagents: [] },
      config: {},
      packageInstallId: pkg.id,
      originalContentChecksum: null,
      sourceType: "package",
      enabled: true,
    };
    return createInMemoryPackageStore({
      packages: [pkg],
      agents: [orchestrator, worker],
    });
  }

  function registerMockCheckpoint(registry: ReturnType<typeof createToolRegistry>) {
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "mock_checkpoint",
        description: "mock",
        inputSchema: {
          type: "object",
          properties: { checkpointId: { type: "string" } },
          required: ["checkpointId"],
        },
      },
      capability: "checkpoint",
      execution: {
        type: "server",
        handler: (async (input, ctx: CheckpointToolHandlerContext) => {
          const args = input as { checkpointId: string };
          return ctx.checkpoint({
            checkpointId: args.checkpointId,
            prompt: "provide seeds",
            artifacts: [],
            answerSchema: { type: "object", properties: { seeds: { type: "string" } } },
          });
        }) as ToolHandler<CheckpointToolHandlerContext>,
      },
    });
  }

  async function setupNestedRuntime(gateway: Gateway, budget = createDefaultTreeBudget()) {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const eventWriter = createInMemoryEventJournalWriter();
    const checkpointRegistry = createCheckpointRegistry();
    const hub = createThreadEventHub({
      journalWriter: eventWriter,
      journalReader: eventWriter,
      eventSink: createInMemoryEventSink(),
    });
    const packageRepository = seedOrchestratorPackage(project.id);
    const toolRegistry = createToolRegistry();
    registerMockCheckpoint(toolRegistry);
    const toolExecutor = createToolExecutor(toolRegistry);
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });

    let orchestrator: ReturnType<typeof createOrchestrator>;
    const runner = createTurnRunner({
      orchestrator: { runTurn: (input) => orchestrator.runTurn(input) },
      hub,
      repos: { turns: repos.turns },
      eventSink: createInMemoryEventSink(),
    });

    const coordinator = createChildRunCoordinator({
      orchestrator: { runTurn: (input) => orchestrator.runTurn(input) },
      repos: {
        threads: repos.threads,
        subagentThreads: repos.threads,
        turns: repos.turns,
        blocks: repos.blocks,
      },
      eventWriter,
      packageRepository,
      childRunRegistry: runner.childRunRegistry,
      helperResultDelivery: createHelperResultDelivery({
        repos,
        eventWriter,
        getRunningTurnId: (threadId) => runner.getRunningTurnId(threadId),
      }),
      creditLedger,
    });

    for (const registration of createSpawnToolRegistrations()) {
      toolRegistry.register(registration);
    }

    orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        toolExecutor,
        repos,
        eventWriter: hub,
        packageRepository,
        toolRegistry,
        childRunCoordinator: coordinator,
        checkpointRegistry,
        creditLedger,
        eventSink: createInMemoryEventSink(),
      }),
    );

    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      currentAgent: "orchestrator",
      systemPrompt: "You orchestrate workers.",
    });

    return {
      repos,
      eventWriter,
      orchestrator,
      thread,
      budget,
      runner,
      creditLedger,
      checkpointRegistry,
    };
  }

  async function collectEvents(handle: {
    events: AsyncIterable<OrchestratorEvent>;
  }): Promise<OrchestratorEvent[]> {
    const events: OrchestratorEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    return events;
  }

  function nestedRunGateway(): Gateway & { getCallCount(): number } {
    let call = 0;
    return {
      getCallCount: () => call,
      async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
        call += 1;
        let result: GenerateResult;
        switch (call) {
          case 1:
            result = toolUseResult("call-spawn-1", "spawn", {
              agent: "worker",
              prompt: "segment the volume",
            });
            break;
          case 2:
            result = toolUseResult("call-return-1", "return_result", {
              summary: "needs seeds",
              payload: { status: "needs-input", flags: ["seed"] },
            });
            break;
          case 3:
            result = toolUseResult("call-checkpoint", "mock_checkpoint", {
              checkpointId: "cp-seeds",
            });
            break;
          case 4:
            result = toolUseResult("call-spawn-2", "spawn", {
              agent: "worker",
              prompt: "continue with seeds",
            });
            break;
          case 5:
            result = toolUseResult("call-return-2", "return_result", {
              summary: "done",
              payload: { status: "completed" },
            });
            break;
          case 6:
            result = {
              content: [{ type: "text", text: "all finished" }],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
              model: "stub",
              provider: "stub",
            };
            break;
          default:
            throw new Error(`unexpected model call ${call}`);
        }
        yield { type: "end", result };
      },
      async generate() {
        throw new Error("not used");
      },
    };
  }

  function toolUseResult(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): GenerateResult {
    return {
      content: [{ type: "tool_use", toolCallId, toolName, input }],
      toolCalls: [],
      finishReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "stub",
      provider: "stub",
    };
  }

  function pricedToolUseResult(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): GenerateResult {
    return {
      content: [{ type: "tool_use", toolCallId, toolName, input }],
      toolCalls: [],
      finishReason: "tool_use",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      model: "gpt-4.1-mini",
      provider: "openai",
    };
  }

  it("parent spawns child, checkpoint resumes same root turn, re-spawns to completion", async () => {
    const gateway = nestedRunGateway();
    const { repos, eventWriter, orchestrator, thread, checkpointRegistry } =
      await setupNestedRuntime(gateway);

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "run pipeline",
    });

    const eventsPromise = collectEvents(handle);
    await waitForEvent(eventWriter, thread.id, "checkpoint.created");
    const checkpointCreated = eventWriter
      .getEvents(thread.id)
      .map((entry) => entry.event)
      .find((event) => event.type === "checkpoint.created");
    expect(checkpointCreated?.type).toBe("checkpoint.created");
    const assistantTurnId =
      checkpointCreated?.type === "checkpoint.created" ? checkpointCreated.turnId : "";
    expect(gateway.getCallCount()).toBe(3);

    checkpointRegistry.resolve({
      threadId: thread.id,
      turnId: assistantTurnId,
      checkpointId: "cp-seeds",
      value: { seeds: "1,2,3" },
    });

    const events = await eventsPromise;
    const journalEvents = eventWriter.getEvents(thread.id).map((entry) => entry.event);
    expect(journalEvents.filter((event) => event.type === "agent.spawn")).toHaveLength(2);
    expect(journalEvents.filter((event) => event.type === "agent.spawn_completed")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(gateway.getCallCount()).toBe(6);

    const childThreads = (await repos.threads.listByUser("user-1")).filter(
      (row) => row.kind === "subagent",
    );
    expect(childThreads).toHaveLength(2);
    expect(childThreads.every((row) => row.spawnStatus === "succeeded")).toBe(true);
  });

  it("debits nested model calls and rolls up by root thread and agent", async () => {
    let call = 0;
    const gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: pricedToolUseResult("call-spawn", "spawn", { agent: "worker", prompt: "go" }),
          };
          return;
        }
        if (call === 2) {
          yield {
            type: "end",
            result: pricedToolUseResult("call-return", "return_result", { summary: "child done" }),
          };
          return;
        }
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "parent done" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            model: "gpt-4.1-mini",
            provider: "openai",
          },
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };

    const { orchestrator, thread, repos, creditLedger } = await setupNestedRuntime(
      gateway as Gateway,
    );
    await collectEvents(await orchestrator.runTurn({ threadId: thread.id, userText: "run" }));

    expect(
      await creditLedger.getRunDebitTotal({
        userId: "user-1",
        projectId: thread.projectId,
        rootThreadId: thread.id,
      }),
    ).toBe("600000");
    expect(
      await creditLedger.getAgentDebitTotals({
        userId: "user-1",
        projectId: thread.projectId,
        rootThreadId: thread.id,
      }),
    ).toEqual([
      { agentSlug: "orchestrator", millicredits: "400000" },
      { agentSlug: "worker", millicredits: "200000" },
    ]);

    const child = (await repos.threads.listByUser("user-1")).find((row) => row.kind === "subagent");
    expect(child?.spawnResult).toMatchObject({
      status: "completed",
      report: expect.objectContaining({ costMillicredits: 200000 }),
    });
  });

  it("rejects spawn when maxDepth would be exceeded", async () => {
    const gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield {
          type: "end",
          result: toolUseResult("call-spawn", "spawn", {
            agent: "worker",
            prompt: "task",
          }),
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const { orchestrator, thread, repos } = await setupNestedRuntime(gateway as Gateway);
    const depth2Thread = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: thread.projectId,
      parentThreadId: thread.id,
      rootThreadId: thread.id,
      originTurnId: "turn-origin",
      spawnDepth: 2,
      currentAgent: "orchestrator",
      composedSystemPrompt: "deep",
      bakedSkillSlugs: [],
      spawnStatus: "running",
    });

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: depth2Thread.id,
        userText: "too deep",
        treeBudget: createDefaultTreeBudget({ maxDepth: 2 }),
        isSubagentThread: true,
      }),
    );

    const spawnResultBlock = await findSpawnToolResult(repos, depth2Thread.id);
    expect(spawnResultBlock).toMatchObject({
      output: {
        status: "error",
        error: expect.objectContaining({ code: "spawn_depth_exceeded" }),
      },
    });
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
  });

  it("rejects spawn when turn budget is exhausted", async () => {
    const gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        yield {
          type: "end",
          result: toolUseResult("call-spawn", "spawn", {
            agent: "worker",
            prompt: "task",
          }),
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const budget = createDefaultTreeBudget({ maxTotalTurns: 0 });
    const { orchestrator, thread } = await setupNestedRuntime(gateway as Gateway, budget);

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "no turns left",
        treeBudget: budget,
      }),
    );

    expect(events.some((event) => event.type === "turn.error")).toBe(true);
  });

  it("synthesizes incomplete report when child omits return_result", async () => {
    let call = 0;
    const gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: toolUseResult("call-spawn", "spawn", { agent: "worker", prompt: "go" }),
          };
          return;
        }
        if (call === 2) {
          yield {
            type: "end",
            result: {
              content: [{ type: "text", text: "stopped early" }],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
              model: "stub",
              provider: "stub",
            },
          };
          return;
        }
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "parent done" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "stub",
            provider: "stub",
          },
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };

    const { orchestrator, thread, repos } = await setupNestedRuntime(gateway as Gateway);
    await collectEvents(await orchestrator.runTurn({ threadId: thread.id, userText: "run" }));

    const child = (await repos.threads.listByUser("user-1")).find((row) => row.kind === "subagent");
    expect(child?.spawnResult).toMatchObject({
      status: "completed",
      report: expect.objectContaining({ incomplete: true, summary: "stopped early" }),
    });
  });

  it("maps child turn.error to an error SpawnResult", async () => {
    let call = 0;
    const gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: toolUseResult("call-spawn", "spawn", {
              agent: "worker",
              prompt: "task",
            }),
          };
          return;
        }
        if (call === 2) {
          yield {
            type: "error",
            code: "provider_error",
            message: "child provider failed",
            retryable: false,
          };
          return;
        }
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "parent saw child failure" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "stub",
            provider: "stub",
          },
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };

    const { orchestrator, thread, repos } = await setupNestedRuntime(gateway as Gateway);
    await collectEvents(await orchestrator.runTurn({ threadId: thread.id, userText: "run" }));

    const child = (await repos.threads.listByUser("user-1")).find((row) => row.kind === "subagent");
    expect(child?.spawnStatus).toBe("failed");
    expect(child?.spawnResult).toMatchObject({
      status: "error",
      error: expect.objectContaining({
        code: "provider_error",
        message: "child provider failed",
      }),
    });
  });

  it("propagates parent cancel to an in-flight child run", async () => {
    let childStarted = false;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    let call = 0;
    const gateway = {
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: toolUseResult("call-spawn", "spawn", { agent: "worker", prompt: "slow" }),
          };
          return;
        }
        if (call === 2) {
          childStarted = true;
          await childGate;
          yield {
            type: "end",
            result: toolUseResult("call-return", "return_result", { summary: "late" }),
          };
          return;
        }
        yield {
          type: "end",
          result: {
            content: [{ type: "text", text: "cancelled parent" }],
            toolCalls: [],
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "stub",
            provider: "stub",
          },
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };

    const { orchestrator, thread } = await setupNestedRuntime(gateway as Gateway);
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "run",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);

    await waitUntil(() => childStarted);
    controller.abort();
    releaseChild?.();
    const events = await eventsPromise;
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
  });
});

async function waitForEvent(
  writer: ReturnType<typeof createInMemoryEventJournalWriter>,
  threadId: string,
  type: OrchestratorEvent["type"],
) {
  const started = Date.now();
  while (!writer.getEvents(threadId).some((entry) => entry.event.type === type)) {
    if (Date.now() - started > 2000) throw new Error(`timeout waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitUntil(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function findSpawnToolResult(
  repos: ReturnType<typeof createInMemoryRepositories>,
  threadId: string,
) {
  const blocks = await repos.blocks.listByThread(threadId);
  const toolResult = blocks.find((block) => block.blockType === "tool_result");
  return toolResult?.content as JsonValue;
}
