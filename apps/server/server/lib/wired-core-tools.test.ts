/**
 * Wired core-tool tests: verify production tool registrations bind core tool
 * schemas to ContextPort-backed handlers and record document-touch side effects.
 */
import { meridianErrorFromTool } from "@meridian/contracts/interrupt";
import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../domains/billing/index.js";
import { createInMemoryUnifiedContextPortFactory } from "../domains/context/index.js";
import { MANUSCRIPT_URI } from "../domains/context/manuscript-uri.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createInMemoryWorkRepository } from "../domains/projects/index.js";
import { gatewayStubDefaults } from "../domains/runtime/gateway/test-gateway.js";
import {
  CORE_TOOL_NAMES,
  createCheckpointRegistry,
  createOrchestrator,
  createToolExecutor,
  createToolRegistry,
  type Gateway,
  type GenerateRequest,
  type OrchestratorEvent,
  type StreamEvent,
  type ToolHandler,
} from "../domains/runtime/index.js";
import { createTestOrchestratorDeps } from "../domains/runtime/loop/__tests__/test-orchestrator-deps.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../domains/threads/index.js";
import { createWiredCoreToolRegistrations } from "./wired-core-tools.js";

function buildRegistrations() {
  const repos = createInMemoryRepositories();
  return createWiredCoreToolRegistrations({
    threads: repos.threads,
    contextPorts: createInMemoryUnifiedContextPortFactory(),
    threadWorks: repos.threadWorks,
    documentTouches: repos.documentTouches,
    eventSink: createInMemoryEventSink(),
  });
}

async function collectEvents(
  handleOrGen: AsyncIterable<OrchestratorEvent> | { events: AsyncIterable<OrchestratorEvent> },
): Promise<OrchestratorEvent[]> {
  const gen = "events" in handleOrGen ? handleOrGen.events : handleOrGen;
  const events: OrchestratorEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

async function waitForJournalEvent(
  writer: ReturnType<typeof createInMemoryEventJournalWriter>,
  threadId: string,
  type: OrchestratorEvent["type"],
): Promise<void> {
  const startedAt = Date.now();
  while (!writer.getEvents(threadId).some((entry) => entry.event.type === type)) {
    if (Date.now() - startedAt > 1000)
      throw new Error(`timed out waiting for journal event ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function askUserGateway(): Gateway & { getRequests(): GenerateRequest[] } {
  let call = 0;
  const requests: GenerateRequest[] = [];
  return {
    ...gatewayStubDefaults,
    getRequests: () => requests,
    async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      call += 1;
      if (call === 1) {
        yield {
          type: "end",
          result: {
            content: [
              {
                type: "tool_use",
                toolCallId: "call-ask-user",
                toolName: "ask_user",
                input: {
                  question: "Which analysis should I run?",
                  kind: "choice",
                  options: [
                    { value: "quick", label: "Quick scan" },
                    { value: "full", label: "Full analysis" },
                  ],
                  recommended: "quick",
                  requiresHuman: false,
                  timeoutMs: 1000,
                },
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
            content: [{ type: "text", text: "Continuing with quick scan." }],
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
    async generate() {
      throw new Error("not used in this test");
    },
  };
}

describe("createWiredCoreToolRegistrations", () => {
  it("returns the runnable canonical core tools", () => {
    const exposed = buildRegistrations().map((registration) => registration.definition.name);
    expect(exposed).toEqual([...CORE_TOOL_NAMES]);
  });

  it("registry exposes the wired core set", async () => {
    const registry = createToolRegistry({ registrations: buildRegistrations() });
    expect(registry.getDefinitions().map((tool) => tool.name)).toEqual([...CORE_TOOL_NAMES]);

    const wiredRead = registry.getRegistration("read");
    if (wiredRead?.execution.type !== "server") throw new Error("missing wired read handler");
    const readResult = await (wiredRead.execution.handler as ToolHandler)(
      {},
      {
        signal: new AbortController().signal,
        threadId: "missing-thread",
        turnId: "turn-1",
        agentSlug: null,
      },
    );
    expect(readResult).toEqual({
      isError: true,
      output: meridianErrorFromTool("path is required"),
    });
  });

  it("never includes a throwing placeholder in wired core registrations", async () => {
    const ctx = {
      signal: new AbortController().signal,
      threadId: "missing-thread",
      turnId: "turn-1",
      agentSlug: null,
    };
    for (const registration of buildRegistrations()) {
      if (registration.execution.type !== "server") continue;
      let thrown: unknown;
      try {
        await (registration.execution.handler as ToolHandler)({}, ctx);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
    }
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("executes search through the unified thread port", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);
    const unifiedFactory = createInMemoryUnifiedContextPortFactory();
    const port = unifiedFactory.forWork(work.id, "project_1", "user_1", new Set([work.id]));
    await port.write("kb://protocols/blot.md", "western blot needle\nwash membrane", {
      origin: { type: "system" },
    });
    await port.write("kb://notes.md", "outside the protocols folder", {
      origin: { type: "system" },
    });

    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: unifiedFactory,
          threadWorks: repos.threadWorks,
          documentTouches: repos.documentTouches,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    const result = await executor.executeTool(
      { id: "call-search", name: "search", arguments: { query: "needle", uri: "kb://" } },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: "00000000-0000-4000-8000-000000000002",
        agentSlug: null,
      },
    );

    expect(result).toEqual({
      toolCallId: "call-search",
      output: [
        expect.objectContaining({
          uri: "kb://protocols/blot.md",
          excerpt: expect.stringContaining("needle"),
        }),
      ],
    });
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("routes bootstrap manuscript writes through the unified thread port", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
    const unifiedFactory = createInMemoryUnifiedContextPortFactory();

    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: unifiedFactory,
          threadWorks: repos.threadWorks,
          documentTouches: repos.documentTouches,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    const result = await executor.executeTool(
      {
        id: "call-write-manuscript",
        name: "write",
        arguments: { path: MANUSCRIPT_URI, content: "chapter content" },
      },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: turn.id,
        agentSlug: "agent-one",
      },
    );

    expect(result).toEqual({
      toolCallId: "call-write-manuscript",
      output: {
        path: MANUSCRIPT_URI,
        bytesWritten: Buffer.byteLength("chapter content", "utf8"),
      },
    });

    const read = await unifiedFactory
      .forWork(work.id, "project_1", "user_1", new Set([work.id]))
      .read(MANUSCRIPT_URI);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("chapter content\n");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const touches = await repos.documentTouches.listByThread(thread.id);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ turnId: turn.id });
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("routes work:// writes through the unified thread port", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });

    const unifiedFactory = createInMemoryUnifiedContextPortFactory();
    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: unifiedFactory,
          threadWorks: repos.threadWorks,
          documentTouches: repos.documentTouches,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    await executor.executeTool(
      {
        id: "call-write-notes",
        name: "write",
        arguments: { path: "work://notes.md", content: "scratchpad" },
      },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: turn.id,
        agentSlug: "agent-one",
      },
    );

    const workPort = unifiedFactory.forWork(work.id, "project_1", "user_1", new Set([work.id]));
    const read = await workPort.read("work://notes.md");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("scratchpad\n");
  });

  // TODO(agent-edit): re-enable/rewrite after Step 9 cutover wires @meridian/agent-edit
  it.skip("records document touches after reads and writes via unified kb://", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
    const unifiedFactory = createInMemoryUnifiedContextPortFactory();
    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: unifiedFactory,
          threadWorks: repos.threadWorks,
          documentTouches: repos.documentTouches,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    await executor.executeTool(
      { id: "call-write", name: "write", arguments: { path: "kb://notes.md", content: "hello" } },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: turn.id,
        agentSlug: "agent-one",
      },
    );
    await executor.executeTool(
      { id: "call-read", name: "read", arguments: { path: "kb://notes.md" } },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId: turn.id,
        agentSlug: "agent-one",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const touches = await repos.documentTouches.listByThread(thread.id);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ turnId: turn.id });
  });

  it("validates ask_user choice options and resolves free-text through checkpoint context", async () => {
    const repos = createInMemoryRepositories();
    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: createInMemoryUnifiedContextPortFactory(),
          threadWorks: repos.threadWorks,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );

    const checkpointCalls: Array<{ request: unknown; timeoutMs?: number }> = [];
    const updates: Array<{ checkpointId: string; props: unknown }> = [];
    const checkpointResponses = [
      { value: { value: "choice answer" }, provenance: "user" as const },
      { value: { value: "free-text answer" }, provenance: "user" as const },
    ];
    const ctx = {
      signal: new AbortController().signal,
      threadId: "thread-1",
      turnId: "turn-1",
      agentSlug: null,
      checkpointTimeoutMs: 4321,
      checkpoint: async (request: unknown, timeoutMs?: number) => {
        checkpointCalls.push({ request, timeoutMs });
        const response = checkpointResponses.shift();
        if (!response) throw new Error("unexpected checkpoint call");
        return response;
      },
      updateComponentBlock: async (checkpointId: string, props: Record<string, unknown>) => {
        updates.push({ checkpointId, props });
      },
    };

    await expect(
      executor.executeTool(
        {
          id: "call-choice-missing",
          name: "ask_user",
          arguments: { question: "Choose?", kind: "choice" },
        },
        ctx,
      ),
    ).resolves.toEqual({
      toolCallId: "call-choice-missing",
      output: {
        code: "tool_error",
        message: "options required for choice kind",
        retryable: false,
        source: "tool",
      },
      isError: true,
    });

    await expect(
      executor.executeTool(
        {
          id: "call-choice",
          name: "ask_user",
          arguments: {
            question: "Choose?",
            kind: "choice",
            options: [{ value: "a", label: "Option A" }],
            recommended: "a",
            timeoutMs: 123,
          },
        },
        ctx,
      ),
    ).resolves.toEqual({
      toolCallId: "call-choice",
      output: { value: "choice answer", provenance: "user" },
    });

    await expect(
      executor.executeTool(
        {
          id: "call-free-text",
          name: "ask_user",
          arguments: { question: "Explain?", kind: "free-text", requiresHuman: true },
        },
        ctx,
      ),
    ).resolves.toEqual({
      toolCallId: "call-free-text",
      output: { value: "free-text answer", provenance: "user" },
    });

    expect(checkpointCalls).toHaveLength(2);
    expect(checkpointCalls[0]?.timeoutMs).toBe(123);
    expect(checkpointCalls[1]?.timeoutMs).toBe(4321);
    expect(updates).toEqual([
      {
        checkpointId: (checkpointCalls[0]?.request as { checkpointId: string }).checkpointId,
        props: { resolvedValue: "choice answer", answerProvenance: "user" },
      },
      {
        checkpointId: (checkpointCalls[1]?.request as { checkpointId: string }).checkpointId,
        props: { resolvedValue: "free-text answer", answerProvenance: "user" },
      },
    ]);
  });

  it("runs ask_user through the orchestrator checkpoint round-trip", async () => {
    const repos = createInMemoryRepositories();
    const eventWriter = createInMemoryEventJournalWriter();
    const checkpointRegistry = createCheckpointRegistry();
    const portFactory = createInMemoryUnifiedContextPortFactory();
    const gateway = askUserGateway();
    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: portFactory,
          threadWorks: repos.threadWorks,
          documentTouches: repos.documentTouches,
          eventSink: createInMemoryEventSink(),
        }),
      }),
    );
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      projectId: "project-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        toolExecutor: executor,
        repos,
        eventWriter,
        checkpointRegistry,
        creditLedger,
      }),
    );
    const thread = await repos.threads.create({ userId: "user-1", projectId: "project-1" });

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "Ask before proceeding.",
      tools: executor.getDefinitions?.(),
    });
    const eventsPromise = collectEvents(handle);

    await waitForJournalEvent(eventWriter, thread.id, "checkpoint.created");
    const checkpointCreated = eventWriter
      .getEvents(thread.id)
      .map((entry) => entry.event)
      .find((event) => event.type === "checkpoint.created");
    if (checkpointCreated?.type !== "checkpoint.created")
      throw new Error("missing checkpoint.created");

    expect(
      checkpointRegistry.resolve({
        threadId: thread.id,
        turnId: checkpointCreated.turnId,
        checkpointId: checkpointCreated.checkpointId,
        value: { value: "quick" },
      }),
    ).toEqual({ ok: true });

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "checkpoint.created")).toBe(true);
    expect(events.some((event) => event.type === "checkpoint.resolved")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.completed");

    const blocks = await repos.blocks.listByTurn(checkpointCreated.turnId);
    const customBlock = blocks.find((block) => block.blockType === "custom");
    expect(customBlock?.content).toMatchObject({
      kind: "choice",
      props: {
        question: "Which analysis should I run?",
        options: [
          { value: "quick", label: "quick" },
          { value: "full", label: "full" },
        ],
        recommended: "quick",
        requiresHuman: false,
        resolvedValue: "quick",
        answerProvenance: "user",
      },
      checkpoint: { id: checkpointCreated.checkpointId, timeoutMs: 1000 },
    });

    const toolResult = blocks.find((block) => block.blockType === "tool_result");
    expect(toolResult?.content).toMatchObject({
      toolCallId: "call-ask-user",
      output: { value: "quick", provenance: "user" },
    });

    const secondRequest = gateway.getRequests()[1];
    const assistantIndex =
      secondRequest?.messages.findIndex((message) => message.role === "assistant") ?? -1;
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(secondRequest?.messages[assistantIndex + 1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-ask-user",
          output: { value: "quick", provenance: "user" },
        },
      ],
    });
  });
});
