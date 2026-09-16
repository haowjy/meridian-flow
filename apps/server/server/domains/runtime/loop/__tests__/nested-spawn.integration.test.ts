import { resolveAgentConfiguration } from "../../../packages/index.js";
/**
 * P2b nested-run gate: spawn → child return_result → parent interrupt →
 * resume same root turn → re-spawn → completed; depth/budget/cancel guards.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import type { JsonValue, OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveWorkMembership } from "../../../../lib/work-attachment.js";
import { InMemoryTransactionOwner } from "../../../../shared/in-memory-transaction.js";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryAgentRevisionStore } from "../../../packages/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../../../projects/index.js";
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
  createToolExecutor,
  createToolRegistry,
  type InterruptToolHandlerContext,
  type ToolHandler,
} from "../../tools/index.js";
import { createSpawnToolRegistrations } from "../../tools/spawn-tools.js";
import { createInterruptRegistry } from "../interrupts.js";
import { createOrchestrator } from "../orchestrator.js";
import type { ThreadRunOwnership } from "../thread-run-ownership.js";
import { createTurnRunner } from "../turn-runner.js";
import { gatewayStubDefaults } from "./test-gateway.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

describe("nested spawn runtime (P2b gate)", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  function registerMockInterrupt(registry: ReturnType<typeof createToolRegistry>) {
    registry.register({
      source: "core",
      definition: {
        type: "function",
        name: "mock_interrupt",
        description: "mock",
        inputSchema: {
          type: "object",
          properties: { interruptId: { type: "string" } },
          required: ["interruptId"],
        },
      },
      capability: "interrupt",
      execution: {
        type: "server",
        handler: (async (input, ctx: InterruptToolHandlerContext) => {
          const args = input as { interruptId: string };
          return ctx.interrupt({
            interruptId: args.interruptId,
            prompt: "provide seeds",
            artifacts: [],
            answerSchema: { type: "object", properties: { seeds: { type: "string" } } },
          });
        }) as ToolHandler<InterruptToolHandlerContext>,
      },
    });
  }

  async function setupNestedRuntime(
    gateway: Gateway,
    budget = createDefaultTreeBudget(),
    options: {
      workContextDelivery?: {
        flushOwned(threadId: ThreadId): Promise<void>;
      };
      runOwnership?: ThreadRunOwnership;
      withWork?: boolean;
    } = {},
  ) {
    const projectRepo = createInMemoryProjectRepository();
    const workRepo = createInMemoryWorkRepository();
    const transactionOwner = new InMemoryTransactionOwner();
    const repos = createInMemoryRepositories({
      projects: projectRepo,
      works: workRepo,
      transactionOwner,
      boundAgent: (id) => agentRevisions.boundAgent(id),
    });
    const agentRevisions = createInMemoryAgentRevisionStore({
      transactionOwner,
      threadExists: async (id) =>
        Boolean(await repos.threads.findProjectIdByIdIncludingDeleted(id)),
    });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const eventWriter = createInMemoryEventJournalWriter();
    const interruptRegistry = createInterruptRegistry();
    const hub = createThreadEventHub({
      journalWriter: eventWriter,
      journalReader: eventWriter,
      eventSink: createInMemoryEventSink(),
    });
    const source = {
      coordinate: "fixture/nested",
      files: {
        "agents/orchestrator.md":
          "---\nmodel: stub-model\nmode: primary\nsubagents: [worker]\n---\nYou orchestrate workers.",
        "agents/worker.md": "---\nmodel: stub-model\nmode: subagent\n---\nYou are a worker.",
      },
    };
    const installed = await agentRevisions.installSource(source);
    const parentRevision = installed.definitions.find(
      (revision) => revision.slug === "orchestrator",
    );
    if (!parentRevision) throw new Error("Missing parent fixture definition");
    const toolRegistry = createToolRegistry();
    registerMockInterrupt(toolRegistry);
    const toolExecutor = createToolExecutor(toolRegistry);
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });

    let orchestrator: ReturnType<typeof createOrchestrator>;
    const runner = createTurnRunner({
      workContextDelivery: { async beforeTurn() {}, async flushOwned() {} },
      orchestrator: {
        runTurn: (input) => orchestrator.runTurn(input),
        finalizeGeneratorFailure: (input) => orchestrator.finalizeGeneratorFailure(input),
      },
      hub,
      repos: { turns: repos.turns },
      eventSink: createInMemoryEventSink(),
    });

    const flushWorkContext = vi.fn(async (_threadId: ThreadId) => {});
    const coordinator = createChildRunCoordinator({
      unavailableReasons: () => [],
      defaultModel: () => "test-model",
      orchestrator: {
        runTurn: (input) => orchestrator.runTurn(input),
        finalizeGeneratorFailure: (input) => orchestrator.finalizeGeneratorFailure(input),
      },
      repos: {
        threads: repos.threads,
        subagentThreads: repos.threads,
        turns: repos.turns,
        blocks: repos.blocks,
        transaction: repos.transaction,
        threadWorks: repos.threadWorks,
      },
      resolveWorkMembership: (input) =>
        resolveWorkMembership({ workRepo, threadWorks: repos.threadWorks }, input),
      eventWriter,
      agentRevisions,
      childRunRegistry: runner.childRunRegistry,
      helperResultDelivery: createHelperResultDelivery({
        repos,
        eventWriter,
        getRunningTurnId: (threadId) => runner.getRunningTurnId(threadId),
      }),
      workContextDelivery: options.workContextDelivery ?? { flushOwned: flushWorkContext },
      runOwnership: options.runOwnership,
      billingSpendReader: creditLedger,
    });

    for (const registration of createSpawnToolRegistrations()) {
      toolRegistry.register(registration);
    }

    orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        agentRevisions,
        gateway,
        toolExecutor,
        repos,
        eventWriter: hub,
        toolRegistry,
        childRunCoordinator: coordinator,
        interruptRegistry,
        creditLedger,
        eventSink: createInMemoryEventSink(),
      }),
    );

    const thread = await repos.threads.create({
      userId: "user-1",
      projectId: project.id,
      systemPrompt: "You orchestrate workers.",
    });
    await agentRevisions.bindThread(
      thread.id,
      parentRevision.id,
      await resolveAgentConfiguration({
        store: agentRevisions,
        revision: parentRevision,
        defaultModel: "test-model",
      }),
    );
    if (options.withWork !== false) {
      const work = await workRepo.create({ projectId: project.id, name: "Nested Work" });
      await repos.threadWorks.addMembership(thread.id, work.id, true);
    }

    return {
      repos,
      agentRevisions,
      source,
      parentRevision,
      eventWriter,
      orchestrator,
      thread,
      budget,
      runner,
      creditLedger,
      interruptRegistry,
      flushWorkContext,
      coordinator,
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
      ...gatewayStubDefaults,
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
            result = toolUseResult("call-interrupt", "mock_interrupt", {
              interruptId: "cp-seeds",
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

  it("binds the child from the parent's retained package after catalog advancement", async () => {
    const requests: GenerateRequest[] = [];
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request) {
        requests.push(request);
        yield {
          type: "end",
          result: toolUseResult("report", "return_result", { summary: "done" }),
        };
      },
      async generate() {
        throw new Error("unused");
      },
    };
    const { coordinator, thread, repos, agentRevisions, source, parentRevision } =
      await setupNestedRuntime(gateway);
    await agentRevisions.selectRevision({
      ownerUserId: "user-1",
      logicalKey: "nested",
      revisionId: parentRevision.id,
    });
    const advanced = await agentRevisions.installSource({
      ...source,
      files: {
        ...source.files,
        "agents/worker.md": "---\nmodel: different-model\nmode: subagent\n---\nChanged worker.",
      },
    });
    const advancedParent = advanced.definitions.find((item) => item.slug === "orchestrator");
    if (!advancedParent) throw new Error("Missing advanced parent");
    await agentRevisions.selectRevision({
      ownerUserId: "user-1",
      logicalKey: "nested",
      revisionId: advancedParent.id,
      expectedRevisionId: parentRevision.id,
    });
    const result = await coordinator.spawnChild({
      parentThread: thread,
      parentTurnId: "parent-turn",
      agentSlug: "worker",
      prompt: "finish",
      budget: createDefaultTreeBudget(),
    });
    expect(result.status).toBe("completed");
    const child = (await repos.threads.listByUser("user-1")).find(
      (item) => item.kind === "subagent",
    );
    if (!child) throw new Error("Missing child");
    const binding = await agentRevisions.readThreadBinding(child.id);
    expect(binding?.packageRevisionId).toBe(parentRevision.packageRevisionId);
    expect(binding?.slug).toBe("worker");
    expect(child.agentDefinitionRevisionId).toBe(binding?.id);
    expect((await repos.threadWorks.findPrimary(child.id))?.workId).toBe(
      (await repos.threadWorks.findPrimary(thread.id))?.workId,
    );
    expect(requests[0]?.model).toBe("stub-model");
    const system = JSON.stringify(requests[0]?.messages[0]);
    expect(system).toContain("You are a worker.");
    expect(system).toContain("Finish by calling return_result");
    expect(system).not.toContain("Changed worker.");
  });

  it("preserves absent Work membership for a child", async () => {
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream() {
        yield {
          type: "end",
          result: toolUseResult("report", "return_result", { summary: "done" }),
        };
      },
      async generate() {
        throw new Error("unused");
      },
    };
    const { coordinator, thread, repos } = await setupNestedRuntime(
      gateway,
      createDefaultTreeBudget(),
      { withWork: false },
    );
    await coordinator.spawnChild({
      parentThread: thread,
      parentTurnId: "parent-turn",
      agentSlug: "worker",
      prompt: "finish",
      budget: createDefaultTreeBudget(),
    });
    const child = (await repos.threads.listByUser(thread.userId)).find(
      (item) => item.kind === "subagent",
    );
    if (!child) throw new Error("Missing child");
    expect(child.workId).toBeNull();
    expect(await repos.threadWorks.findPrimary(child.id)).toBeNull();
  });

  it("rolls back child, binding, and Work membership after the membership write", async () => {
    const { coordinator, thread, repos, agentRevisions } = await setupNestedRuntime(
      nestedRunGateway(),
    );
    const add = repos.threadWorks.addMembership.bind(repos.threadWorks);
    let childId = "";
    const fault = new Error("binding transaction failure");
    vi.spyOn(repos.threadWorks, "addMembership").mockImplementation(async (id, workId, primary) => {
      childId = id;
      await add(id, workId, primary);
      throw fault;
    });
    await expect(
      coordinator.spawnChild({
        parentThread: thread,
        parentTurnId: "parent-turn",
        agentSlug: "worker",
        prompt: "finish",
        budget: createDefaultTreeBudget(),
      }),
    ).rejects.toBe(fault);
    expect(await repos.threads.findById(childId)).toBeNull();
    expect(await agentRevisions.readThreadBinding(childId)).toBeUndefined();
    expect(await repos.threadWorks.findPrimary(childId)).toBeNull();
  });

  it("parent spawns child, interrupt resumes same root turn, re-spawns to completion", async () => {
    const gateway = nestedRunGateway();
    const { repos, eventWriter, orchestrator, thread, interruptRegistry, flushWorkContext } =
      await setupNestedRuntime(gateway);

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "run pipeline",
    });

    const eventsPromise = collectEvents(handle);
    await waitForEvent(eventWriter, thread.id, "interrupt.created");
    const interruptCreated = eventWriter
      .getEvents(thread.id)
      .map((entry) => entry.event)
      .find((event) => event.type === "interrupt.created");
    expect(interruptCreated?.type).toBe("interrupt.created");
    const assistantTurnId =
      interruptCreated?.type === "interrupt.created" ? interruptCreated.turnId : "";
    expect(gateway.getCallCount()).toBe(3);

    interruptRegistry.resolve({
      threadId: thread.id,
      turnId: assistantTurnId,
      interruptId: "cp-seeds",
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
    expect(flushWorkContext.mock.calls.map(([flushedThreadId]) => flushedThreadId).sort()).toEqual(
      childThreads.map((row) => row.id).sort(),
    );
  });

  it("unregisters a completed child and releases ownership when its update flush fails", async () => {
    const requestedThreads: string[] = [];
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        if (request.correlation?.threadId) requestedThreads.push(request.correlation.threadId);
        yield {
          type: "end",
          result: toolUseResult("call-return", "return_result", { summary: "done" }),
        };
      },
      async generate() {
        throw new Error("not used");
      },
    };
    const owned = new Set<ThreadId>();
    let releaseCalls = 0;
    const runOwnership: ThreadRunOwnership = {
      async tryAcquire(threadId) {
        if (owned.has(threadId)) return null;
        owned.add(threadId);
        return {
          async release() {
            releaseCalls += 1;
            owned.delete(threadId);
          },
        };
      },
    };
    const flushError = new Error("system update flush failed");
    const { coordinator, repos, runner, thread } = await setupNestedRuntime(
      gateway,
      createDefaultTreeBudget(),
      {
        runOwnership,
        workContextDelivery: {
          async flushOwned() {
            throw flushError;
          },
        },
      },
    );

    await expect(
      coordinator.spawnChild({
        parentThread: thread,
        parentTurnId: "parent-turn" as TurnId,
        agentSlug: "worker",
        prompt: "finish",
        budget: createDefaultTreeBudget(),
      }),
    ).rejects.toBe(flushError);

    const [child] = (await repos.threads.listByUser("user-1")).filter(
      (candidate) => candidate.kind === "subagent",
    );
    expect(child).toBeDefined();
    expect(requestedThreads).toEqual([child?.id]);
    expect(child?.spawnResult).toMatchObject({ status: "completed", report: { summary: "done" } });
    expect(runner.isThreadRunning(child?.id as ThreadId)).toBe(false);
    expect(owned).toHaveLength(0);
    expect(releaseCalls).toBe(1);
  });

  it("debits nested model calls and rolls up by root thread and agent", async () => {
    let call = 0;
    const gateway = {
      ...gatewayStubDefaults,
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

    const child = (await repos.threads.listByUser("user-1")).find((row) => row.kind === "subagent");
    expect(child).toBeDefined();
    expect(
      await creditLedger.getThreadDebitTotal({
        userId: "user-1",
        threadId: thread.id,
      }),
    ).toBe("460000");
    expect(
      await creditLedger.getThreadDebitTotal({
        userId: "user-1",
        threadId: child?.id ?? "missing",
      }),
    ).toBe("230000");

    expect(child?.spawnResult).toMatchObject({
      status: "completed",
      report: expect.objectContaining({ costMillicredits: 230000 }),
    });
  });

  it("rejects spawn when maxDepth would be exceeded", async () => {
    const gateway = {
      ...gatewayStubDefaults,
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
    const { orchestrator, thread, repos, agentRevisions, parentRevision } =
      await setupNestedRuntime(gateway as Gateway);
    const depth2Thread = await repos.threads.createSubagent({
      userId: "user-1",
      projectId: thread.projectId,
      parentThreadId: thread.id,
      rootThreadId: thread.id,
      originTurnId: "turn-origin",
      spawnDepth: 2,
      spawnStatus: "running",
    });
    await agentRevisions.bindThread(
      depth2Thread.id,
      parentRevision.id,
      await resolveAgentConfiguration({
        store: agentRevisions,
        revision: parentRevision,
        defaultModel: "test-model",
      }),
    );

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
      ...gatewayStubDefaults,
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
      ...gatewayStubDefaults,
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
      ...gatewayStubDefaults,
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
    let childStarted: string | undefined;
    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    let call = 0;
    const gateway = {
      ...gatewayStubDefaults,
      async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
        call += 1;
        if (call === 1) {
          yield {
            type: "end",
            result: toolUseResult("call-spawn", "spawn", { agent: "worker", prompt: "slow" }),
          };
          return;
        }
        if (request.correlation?.agentSlug === "worker") {
          childStarted = request.correlation.threadId;
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

    const { orchestrator, thread, repos, eventWriter } = await setupNestedRuntime(
      gateway as Gateway,
    );
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "run",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);

    try {
      await waitUntil(() => childStarted !== undefined);
    } finally {
      controller.abort();
      releaseChild?.();
    }
    const events = await eventsPromise;
    await waitForEvent(eventWriter, thread.id, "agent.spawn_completed");
    expect(childStarted).not.toBe(thread.id);
    const child = await repos.threads.findById(childStarted as string);
    expect(child?.spawnStatus).toBe("cancelled");
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
