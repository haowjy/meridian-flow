import { describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../server/domains/billing/index.js";
import { createInMemoryCollabDomain } from "../../server/domains/collab/index.js";
import { createInMemoryUnifiedContextPortFactory } from "../../server/domains/context/index.js";
import { createInMemoryEventSink } from "../../server/domains/observability/index.js";
import { createInMemoryProjectRepository } from "../../server/domains/projects/index.js";
import type {
  Gateway,
  GenerateRequest,
  GenerateResult,
  OrchestratorEvent,
  StreamEvent,
} from "../../server/domains/runtime/index.js";
import {
  createOrchestrator,
  createToolExecutor,
  createToolRegistry,
} from "../../server/domains/runtime/index.js";
import { createTestOrchestratorDeps } from "../../server/domains/runtime/loop/__tests__/test-orchestrator-deps.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../server/domains/threads/index.js";
import { createWiredCoreToolRegistrations } from "../../server/lib/wired-core-tools.js";

const FILE_URI = "kb://notes.md";
const FILE_CONTENT = "Smoke test seed content";

function createScriptedGateway(
  results: GenerateResult[],
): Gateway & { getStreamCallCount(): number } {
  let callCount = 0;
  return {
    getStreamCallCount() {
      return callCount;
    },
    async *stream(_request: GenerateRequest): AsyncGenerator<StreamEvent> {
      callCount += 1;
      const result = results[callCount - 1];
      if (!result) throw new Error(`No stubbed gateway result for model call ${callCount}`);
      yield { type: "end", result };
    },
    async generate(_request: GenerateRequest) {
      throw new Error("generate is not used in this smoke");
    },
  };
}

async function collectEvents(
  handleOrGen: AsyncIterable<OrchestratorEvent> | { events: AsyncIterable<OrchestratorEvent> },
): Promise<OrchestratorEvent[]> {
  const gen = "events" in handleOrGen ? handleOrGen.events : handleOrGen;
  const events: OrchestratorEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("smoke: in-process turn", () => {
  it("runs write view through wired ContextPort tools and persists the turn lifecycle", async () => {
    const gateway = createScriptedGateway([
      {
        content: [
          {
            type: "tool_use",
            toolCallId: "call-view-smoke",
            toolName: "write",
            input: { command: "view", path: FILE_URI },
          },
        ],
        toolCalls: [],
        finishReason: "tool_use",
        usage: { inputTokens: 12, outputTokens: 8 },
        model: "mock-model",
        provider: "mock",
      },
      {
        content: [{ type: "text", text: `File says: ${FILE_CONTENT}` }],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 14, outputTokens: 7 },
        model: "mock-model",
        provider: "mock",
      },
    ]);

    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "smoke-user", title: "Smoke" });
    const thread = await repos.threads.create({ userId: "smoke-user", projectId: project.id });
    const documentSync = createInMemoryCollabDomain();
    const contextPorts = createInMemoryUnifiedContextPortFactory({ documentSync });
    const writeResult = await contextPorts
      .forProject(project.id, project.userId)
      .write(FILE_URI, FILE_CONTENT, { origin: { type: "system" } });
    expect(writeResult.ok).toBe(true);

    const toolRegistry = createToolRegistry({
      registrations: createWiredCoreToolRegistrations({
        threads: repos.threads,
        contextPorts,
        documentSync,
        threadWorks: repos.threadWorks,
        documentTouches: repos.documentTouches,
        eventSink: createInMemoryEventSink(),
      }),
    });
    const toolExecutor = createToolExecutor(toolRegistry);
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "smoke-user",
      projectId: project.id,
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "smoke",
    });
    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        repos,
        eventWriter: createInMemoryEventJournalWriter(),
        toolRegistry,
        toolExecutor,
        creditLedger,
      }),
    );

    const events = await collectEvents(
      await orchestrator.runTurn({ threadId: thread.id, userText: "Read the notes file." }),
    );

    expect(gateway.getStreamCallCount()).toBe(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.result", toolCallId: "call-view-smoke" }),
        expect.objectContaining({ type: "turn.completed" }),
      ]),
    );

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    const assistantTurn = turns.find((turn) => turn.role === "assistant");
    expect(assistantTurn?.status).toBe("complete");

    const blocks = await repos.blocks.listByTurn(assistantTurn?.id ?? "missing");
    const toolResultBlock = blocks.find((block) => block.blockType === "tool_result");
    expect(toolResultBlock?.content).toMatchObject({
      toolCallId: "call-view-smoke",
      output: expect.stringContaining(FILE_CONTENT),
    });
  });
});
