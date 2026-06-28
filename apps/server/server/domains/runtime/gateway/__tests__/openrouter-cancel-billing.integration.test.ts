/**
 * OpenRouter cancel billing integration: the orchestrator stays provider-neutral
 * while the gateway reconciles hard-cancelled OpenRouter usage before persistence.
 */
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
} from "../../../threads/index.js";
import { createTestOrchestratorDeps } from "../../loop/__tests__/test-orchestrator-deps.js";
import { createCheckpointRegistry } from "../../loop/checkpoints.js";
import { createOrchestrator } from "../../loop/orchestrator.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import {
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
} from "../adapters/mock/server.js";
import { fetchOpenRouterGeneration } from "../adapters/openrouter/generation.js";
import { createGateway } from "../create-gateway.js";
import type { Gateway } from "../index.js";

vi.mock("../adapters/openrouter/generation.js", () => ({
  fetchOpenRouterGeneration: vi.fn(),
}));

async function collectEvents(handle: { events: AsyncIterable<OrchestratorEvent> }) {
  const events: OrchestratorEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function createOpenRouterGateway(mock: MockOpenAIServer): Gateway {
  return createGateway({
    providers: [
      {
        id: "openrouter",
        adapter: "openrouter",
        baseUrl: mock.baseUrl,
        auth: { apiKey: "test-openrouter-key" },
        models: [
          {
            id: "openai/gpt-4o",
            provider: "openrouter",
            displayName: "GPT-4o",
            contextWindow: 128_000,
            maxOutputTokens: 4096,
            capabilities: new Set(["streaming"]),
          },
        ],
      },
    ],
    defaultModel: "openai/gpt-4o",
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
  });
}

async function setup(gateway: Gateway) {
  const projectRepo = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects: projectRepo });
  const project = await projectRepo.create({ userId: "user-1", title: "WB" });
  const creditLedger = createInMemoryCreditLedger();
  const eventWriter = createInMemoryEventJournalWriter();
  const checkpointRegistry = createCheckpointRegistry();
  const hub = createThreadEventHub({
    journalWriter: eventWriter,
    journalReader: eventWriter,
    eventSink: createInMemoryEventSink(),
  });
  const orchestrator = createOrchestrator(
    createTestOrchestratorDeps({
      gateway,
      toolExecutor: createToolExecutor(createToolRegistry()),
      repos,
      eventWriter: hub,
      checkpointRegistry,
      creditLedger,
      eventSink: createInMemoryEventSink(),
    }),
  );
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  await creditLedger.grant({
    userId: "user-1",
    source: "manual",
    amountMillicredits: "1000000",
    reason: "openrouter cancel tests",
  });
  return { thread, creditLedger, orchestrator };
}

async function waitForStreamStart() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("OpenRouter cancel billing", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("reconciles hard-cancel via gateway settlement and persists provider-reported cost", async () => {
    vi.mocked(fetchOpenRouterGeneration).mockResolvedValue({
      id: "gen-hard-cancel",
      total_cost: 0.25,
      native_tokens_prompt: 1000,
      native_tokens_completion: 500,
    });

    const { thread, creditLedger, orchestrator } = await setup(createOpenRouterGateway(mock));
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "openrouter hard cancel",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await waitForStreamStart();
    controller.abort();
    const events = await eventsPromise;

    expect(fetchOpenRouterGeneration).toHaveBeenCalledWith(
      "gen-hard-cancel",
      "test-openrouter-key",
      mock.baseUrl,
      expect.any(AbortSignal),
    );
    const calls = vi.mocked(fetchOpenRouterGeneration).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const reconcileSignal = calls.find(([, , , signal]) => !signal?.aborted)?.[3];
    expect(reconcileSignal).toBeDefined();
    expect(reconcileSignal?.aborted).toBe(false);

    const response = events.find((event) => event.type === "model.response_received");
    expect(response?.type).toBe("model.response_received");
    if (response?.type === "model.response_received") {
      expect(response.response.providerRequestId).toBe("gen-hard-cancel");
      expect(response.response.priceSource).toBe("provider_reported");
    }
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    const balance = await creditLedger.getBalance({
      userId: "user-1",
    });
    expect(BigInt(balance)).toBeLessThan(1_200_000n);
  });
});
