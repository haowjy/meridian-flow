/**
 * Orchestrator model-request debug capture: complete canonical request per call.
 */
import { createDefaultTreeBudget } from "@meridian/contracts/spawn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../../threads/index.js";
import {
  createGateway,
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
  mockProviderConfig,
} from "../../gateway/index.js";
import { createInMemoryModelRequestDebugStore } from "../../model-request-debug/index.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

describe("orchestrator model-request debug capture", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("records the complete request and joins it to the gateway call", async () => {
    const projectRepo = createInMemoryProjectRepository();
    const repos = createInMemoryRepositories({ projects: projectRepo });
    const project = await projectRepo.create({ userId: "user-1", title: "WB" });
    const thread = await repos.threads.create({
      projectId: project.id,
      id: "thread-1",
      userId: "user-1",
      title: null,
      systemPrompt: "You are a helpful assistant.",
      currentAgent: "agent-one",
    });
    const creditLedger = createInMemoryCreditLedger();
    await creditLedger.grant({
      userId: "user-1",
      source: "manual",
      amountMillicredits: "1000000000",
      reason: "test",
    });

    const modelRequestDebug = createInMemoryModelRequestDebugStore();
    const gateway = createGateway({
      providers: [mockProviderConfig(mock.baseUrl)],
      defaultModel: "mock-llm-v1",
    });

    const orchestrator = createOrchestrator(
      createTestOrchestratorDeps({
        gateway,
        repos,
        eventWriter: createInMemoryEventJournalWriter(),
        creditLedger,
        modelRequestDebug,
        notices: {
          async record() {},
          async drainForModelContext() {
            return [
              {
                id: 1,
                kind: "awareness_degraded",
                scope: { kind: "thread" as const, threadId: thread.id },
                message: "",
                data: { documentNames: ["chapter-debug"] },
                createdAt: new Date("2026-07-10T00:00:00.000Z"),
              },
            ];
          },
        },
        projectPreferences: {
          async read() {
            return { threadGroupBy: "work", pinnedThreadIds: [], defaultAgentSlug: null };
          },
        },
      }),
    );

    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "hello",
      treeBudget: createDefaultTreeBudget(),
    });

    for await (const _event of handle.events) {
      // The debug record is finalized only after the event stream is consumed.
    }

    const records = modelRequestDebug.listByTurn(thread.id, handle.assistantTurnId);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const first = records[0];
    expect(first).toMatchObject({
      schema: "meridian.model-request-debug.v1",
      threadId: thread.id,
      turnId: handle.assistantTurnId,
      iteration: 0,
      agentSlug: "agent-one",
      capture: { status: "complete" },
    });
    expect(first?.gatewayCallId).toEqual(expect.any(String));
    expect(first?.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.requestBytes).toBeGreaterThan(0);
    expect(JSON.stringify(first?.request?.messages[0])).toContain("You are a helpful assistant.");
    expect(JSON.stringify(first?.request?.messages[0])).not.toContain("chapter-debug");
    expect(JSON.stringify(first?.request)).toContain("hello");
    expect(JSON.stringify(first?.request)).toContain("chapter-debug");
  });
});
