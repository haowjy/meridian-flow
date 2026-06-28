/**
 * Orchestrator model-request debug capture: records per gateway call with turn,
 * iteration, agent, and verbatim system prompts.
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

  it("records at least one debug row per assistant turn with system prompts", async () => {
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
      // drain
    }

    const records = modelRequestDebug.listByTurn(thread.id, handle.assistantTurnId);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const first = records[0];
    expect(first).toMatchObject({
      threadId: thread.id,
      turnId: handle.assistantTurnId,
      iteration: 0,
      agentSlug: "agent-one",
    });
    expect(first?.systemMessages.join("\n")).toContain("You are a helpful assistant.");
    expect(first?.messageCount).toBeGreaterThanOrEqual(1);
  });
});
