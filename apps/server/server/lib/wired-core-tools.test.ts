/**
 * Wired core-tool tests: verify production tool registrations bind core tool
 * schemas to context/collab-backed handlers and record document-touch side effects.
 */
import { meridianErrorFromTool } from "@meridian/contracts/interrupt";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryCreditLedger } from "../domains/billing/index.js";
import { createInMemoryCollabDomain } from "../domains/collab/index.js";
import { createInMemoryUnifiedContextPortFactory } from "../domains/context/index.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../domains/projects/index.js";
import { gatewayStubDefaults } from "../domains/runtime/gateway/test-gateway.js";
import {
  CORE_TOOL_NAMES,
  createCheckpointRegistry,
  createOrchestrator,
  createToolExecutor,
  createToolRegistry,
  type Gateway,
  type GenerateRequest,
  type GenerateResult,
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

type WiredTestGraphOptions = {
  works?: ReturnType<typeof createInMemoryWorkRepository>;
  documentSync?: ReturnType<typeof createInMemoryCollabDomain>;
  toolDocumentSync?: Pick<
    ReturnType<typeof createInMemoryCollabDomain>,
    "agentEdit" | "refreshDocumentProjection"
  >;
  eventSink?: ReturnType<typeof createInMemoryEventSink>;
};

function wiredTestGraph(input: WiredTestGraphOptions = {}) {
  const documentSync = input.documentSync ?? createInMemoryCollabDomain();
  const contextPorts = createInMemoryUnifiedContextPortFactory({ documentSync });
  const repos = createInMemoryRepositories(input.works ? { works: input.works } : undefined);
  const eventSink = input.eventSink ?? createInMemoryEventSink();
  const registrations = createWiredCoreToolRegistrations({
    threads: repos.threads,
    contextPorts,
    documentSync: input.toolDocumentSync ?? documentSync,
    threadWorks: repos.threadWorks,
    documentTouches: repos.documentTouches,
    eventSink,
  });
  return { documentSync, contextPorts, repos, registrations, eventSink };
}

function buildRegistrations() {
  return wiredTestGraph().registrations;
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

async function wiredWriteHarness(input: WiredTestGraphOptions = {}) {
  const graph = wiredTestGraph(input);
  const thread = await graph.repos.threads.create({ userId: "user-1", projectId: "project-1" });
  const executor = createToolExecutor(createToolRegistry({ registrations: graph.registrations }));
  const port = graph.contextPorts.forProject("project-1", "user-1");

  async function write(id: string, args: Record<string, unknown>, turnId = "turn-write") {
    return executor.executeTool(
      { id, name: "write", arguments: args },
      {
        signal: new AbortController().signal,
        threadId: thread.id,
        turnId,
        agentSlug: null,
      },
    );
  }

  return { ...graph, thread, executor, port, write };
}

type WriteExecutionResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof wiredWriteHarness>>["write"]>
>;

function stringOutput(result: WriteExecutionResult): string {
  expect(result.isError).toBeUndefined();
  expect(typeof result.output).toBe("string");
  return result.output as string;
}

function errorMessage(result: WriteExecutionResult): string {
  expect(result.isError).toBe(true);
  expect(result.output).toMatchObject({ code: "tool_error" });
  return (result.output as { message: string }).message;
}

function firstHashContaining(viewOutput: string, text: string): string {
  const line = viewOutput.split("\n").find((candidate) => candidate.includes(text));
  const hash = line?.split("|", 1)[0];
  if (!hash) throw new Error(`missing block hash for ${text} in:\n${viewOutput}`);
  return hash;
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

function scriptedToolGateway(
  toolCalls: Array<{ id: string; input: Record<string, unknown> }>,
): Gateway & { getRequests(): GenerateRequest[] } {
  let call = 0;
  const requests: GenerateRequest[] = [];
  function toolUse(callInput: { id: string; input: Record<string, unknown> }): GenerateResult {
    return {
      content: [
        {
          type: "tool_use",
          toolCallId: callInput.id,
          toolName: "write",
          input: callInput.input,
        },
      ],
      toolCalls: [],
      finishReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "stub-model",
      provider: "stub",
    };
  }
  return {
    ...gatewayStubDefaults,
    getRequests: () => requests,
    async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      const next = toolCalls[call++];
      yield {
        type: "end",
        result: next
          ? toolUse(next)
          : {
              content: [{ type: "text", text: "done" }],
              toolCalls: [],
              finishReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
              model: "stub-model",
              provider: "stub",
            },
      };
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
    expect(registry.getRegistration("read")).toBeUndefined();
    expect(registry.getRegistration("edit")).toBeUndefined();

    const wiredWrite = registry.getRegistration("write");
    if (wiredWrite?.execution.type !== "server") throw new Error("missing wired write handler");
    const writeResult = await (wiredWrite.execution.handler as ToolHandler)(
      {},
      {
        signal: new AbortController().signal,
        threadId: "missing-thread",
        turnId: "turn-1",
        agentSlug: null,
      },
    );
    expect(writeResult).toEqual({
      isError: true,
      output: meridianErrorFromTool("command is required"),
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

  it("executes search through the unified thread port", async () => {
    const works = createInMemoryWorkRepository();
    const { contextPorts, repos, registrations } = wiredTestGraph({ works });
    const thread = await repos.threads.create({ userId: "user_1", projectId: "project_1" });
    const work = await works.create({
      projectId: "project_1",
      createdByUserId: "user_1",
      title: "Book 1",
    });
    await repos.threadWorks.addMembership(thread.id, work.id, true);
    const port = contextPorts.forWork(work.id, "project_1", "user_1", new Set([work.id]));
    await port.write("kb://protocols/blot.md", "western blot needle\nwash membrane", {
      origin: { type: "system" },
    });
    await port.write("kb://notes.md", "outside the protocols folder", {
      origin: { type: "system" },
    });

    const executor = createToolExecutor(createToolRegistry({ registrations }));

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

  it("runs write(command=...) through a real orchestrator turn", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "Tool Project" });
    const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
    const documentSync = createInMemoryCollabDomain();
    const contextPorts = createInMemoryUnifiedContextPortFactory({ documentSync });
    const registrations = createWiredCoreToolRegistrations({
      threads: repos.threads,
      contextPorts,
      documentSync,
      threadWorks: repos.threadWorks,
      documentTouches: repos.documentTouches,
      eventSink: createInMemoryEventSink(),
    });
    const toolRegistry = createToolRegistry({ registrations });
    const executor = createToolExecutor(toolRegistry);
    const gateway = scriptedToolGateway([
      {
        id: "call-create",
        input: {
          command: "create",
          path: "kb://story.md",
          content: "# Chapter\n\nAlpha sword.\n\nBeta waits.",
        },
      },
      { id: "call-view", input: { command: "view", path: "kb://story.md" } },
      {
        id: "call-replace",
        input: { command: "replace", path: "kb://story.md", find: "sword", content: "blade" },
      },
      {
        id: "call-insert",
        input: { command: "insert", path: "kb://story.md", content: "Gamma arrives." },
      },
      { id: "call-undo", input: { command: "undo", path: "kb://story.md" } },
      { id: "call-view-after-undo", input: { command: "view", path: "kb://story.md" } },
      { id: "call-redo", input: { command: "redo", path: "kb://story.md" } },
      { id: "call-view-after-redo", input: { command: "view", path: "kb://story.md" } },
    ]);
    const eventWriter = createInMemoryEventJournalWriter();
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
        toolExecutor: executor,
        toolRegistry,
        repos,
        eventWriter,
        checkpointRegistry: createCheckpointRegistry(),
        creditLedger,
      }),
    );

    const events = await collectEvents(
      await orchestrator.runTurn({
        threadId: thread.id,
        userText: "Edit the story.",
        tools: executor.getDefinitions?.(),
      }),
    );

    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    const assistantTurn = (await repos.turns.listByThread(thread.id)).find(
      (turn) => turn.role === "assistant",
    );
    if (!assistantTurn) throw new Error("missing assistant turn");
    const toolResults = (await repos.blocks.listByTurn(assistantTurn.id))
      .filter((block) => block.blockType === "tool_result")
      .sort((a, b) => a.sequence - b.sequence)
      .map((block) => block.content as { toolCallId?: string; output?: unknown });
    const outputByCallId = new Map(
      toolResults.map((result) => [result.toolCallId, result.output] as const),
    );
    const outputFor = (toolCallId: string): string => {
      const output = outputByCallId.get(toolCallId);
      expect(typeof output).toBe("string");
      return output as string;
    };

    expect([...outputByCallId.keys()]).toEqual([
      "call-create",
      "call-view",
      "call-replace",
      "call-insert",
      "call-undo",
      "call-view-after-undo",
      "call-redo",
      "call-view-after-redo",
    ]);
    expect(outputFor("call-create")).toContain("status: success");
    expect(outputFor("call-view")).toContain("Alpha sword.");
    expect(outputFor("call-replace")).toContain("status: success");
    expect(outputFor("call-insert")).toContain("Gamma arrives");
    expect(outputFor("call-undo")).toContain("status: reversed");
    const afterUndo = outputFor("call-view-after-undo");
    expect(afterUndo).not.toContain("Alpha blade.");
    expect(afterUndo).not.toContain("Gamma arrives.");
    expect(outputFor("call-redo")).toContain("status: reversed");
    const afterRedo = outputFor("call-view-after-redo");
    expect(afterRedo).toContain("Alpha blade.");
    expect(afterRedo).not.toContain("Alpha sword.");
    expect(afterRedo).toContain("Gamma arrives.");

    const read = await contextPorts.forProject(project.id, "user-1").read("kb://story.md");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toContain("Alpha blade.");
      expect(read.value.content).not.toContain("Alpha sword.");
      expect(read.value.content).toContain("Gamma arrives.");
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    const touches = await repos.documentTouches.listByThread(thread.id);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ turnId: assistantTurn.id });
  });

  it("does not status-sniff write(command=view) document content", async () => {
    const baseDocumentSync = createInMemoryCollabDomain();
    const rawBody = "status: not_found\n\nThis is valid prose.";
    const { port, write } = await wiredWriteHarness({
      documentSync: baseDocumentSync,
      toolDocumentSync: {
        agentEdit: () => ({
          ...baseDocumentSync.agentEdit(),
          write: async () => rawBody,
        }),
        refreshDocumentProjection: baseDocumentSync.refreshDocumentProjection,
      },
    });
    await port.write("kb://status-body.md", rawBody, { origin: { type: "system" } });

    const result = await write("call-view-status-body", {
      command: "view",
      path: "kb://status-body.md",
    });

    expect(result).toEqual({
      toolCallId: "call-view-status-body",
      output: rawBody,
    });
  });

  it("surfaces ambiguous replace as a tool error through the wired handler", async () => {
    const { port, write } = await wiredWriteHarness();
    await port.write("kb://ambiguous.md", "sword one\n\nsword two", {
      origin: { type: "system" },
    });
    stringOutput(
      await write("call-view-ambiguous", { command: "view", path: "kb://ambiguous.md" }),
    );

    const message = errorMessage(
      await write("call-replace-ambiguous", {
        command: "replace",
        path: "kb://ambiguous.md",
        find: "sword",
        content: "blade",
      }),
    );

    expect(message).toContain("status: ambiguous_match");
    expect(message).toContain("Found 2 matches");
  });

  it.each([
    "insert",
    "replace",
  ] as const)("rejects write(command=%s) without content before dispatch", async (command) => {
    const { write } = await wiredWriteHarness();

    const message = errorMessage(
      await write(`call-${command}-missing-content`, {
        command,
        path: "kb://missing-content.md",
        ...(command === "replace" ? { find: "needle" } : {}),
      }),
    );

    expect(message).toBe("content is required");
  });

  it("surfaces create on an existing document as a tool error", async () => {
    const { port, write } = await wiredWriteHarness();
    await port.write("kb://existing.md", "Existing draft.", { origin: { type: "system" } });

    const message = errorMessage(
      await write("call-create-existing", {
        command: "create",
        path: "kb://existing.md",
        content: "Replacement draft.",
      }),
    );

    expect(message).toContain("status: invalid_write");
    expect(message).toContain("File already exists");
  });

  it("routes view and replace through #fragment document addresses", async () => {
    const { port, write } = await wiredWriteHarness();
    await port.write("kb://fragment.md", "Alpha target.\n\nBeta safe.", {
      origin: { type: "system" },
    });
    const fullView = stringOutput(
      await write("call-view-fragment-source", { command: "view", path: "kb://fragment.md" }),
    );
    const alphaHash = firstHashContaining(fullView, "Alpha target.");

    const fragmentView = stringOutput(
      await write("call-view-fragment", {
        command: "view",
        path: `kb://fragment.md#${alphaHash}`,
      }),
    );
    expect(fragmentView).toContain("Alpha target.");
    expect(fragmentView).not.toContain("Beta safe.");

    const replace = stringOutput(
      await write("call-replace-fragment", {
        command: "replace",
        path: `kb://fragment.md#${alphaHash}`,
        find: "target",
        content: "changed",
      }),
    );
    expect(replace).toContain("status: success");

    const read = await port.read("kb://fragment.md");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toContain("Alpha changed.");
      expect(read.value.content).toContain("Beta safe.");
      expect(read.value.content).not.toContain("Alpha target.");
    }
  });

  it("returns mutation success when projection refresh fails after commit", async () => {
    const baseDocumentSync = createInMemoryCollabDomain();
    const eventSink = createInMemoryEventSink();
    const refreshDocumentProjection = vi.fn(async () => {
      throw new Error("projection database unavailable");
    });
    const { port, write } = await wiredWriteHarness({
      documentSync: baseDocumentSync,
      toolDocumentSync: {
        agentEdit: () => baseDocumentSync.agentEdit(),
        refreshDocumentProjection,
      },
      eventSink,
    });

    const create = stringOutput(
      await write("call-create-refresh-fails", {
        command: "create",
        path: "kb://refresh-failure.md",
        content: "Committed despite refresh failure.",
      }),
    );

    expect(create).toContain("status: success");
    expect(refreshDocumentProjection).toHaveBeenCalledTimes(1);
    const read = await port.read("kb://refresh-failure.md");
    expect(read).toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("Committed despite refresh failure.") },
    });
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "lib.wired-core-tools",
        name: "document_projection_refresh.unhandled_failure",
        payload: expect.objectContaining({
          message: "projection database unavailable",
        }),
      }),
    );
  });

  it("validates ask_user choice options and resolves free-text through checkpoint context", async () => {
    const { repos, registrations } = wiredTestGraph();
    const executor = createToolExecutor(createToolRegistry({ registrations }));

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
    void repos;

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
    const documentSync = createInMemoryCollabDomain();
    const portFactory = createInMemoryUnifiedContextPortFactory({ documentSync });
    const gateway = askUserGateway();
    const executor = createToolExecutor(
      createToolRegistry({
        registrations: createWiredCoreToolRegistrations({
          threads: repos.threads,
          contextPorts: portFactory,
          documentSync,
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
