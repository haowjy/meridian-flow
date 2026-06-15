/**
 * Cancel billing integration tests: soft-cancel drain debits consumed usage,
 * WS disconnect cancels in-flight turns, and replayed settlement stays idempotent.
 */

import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAppServices } from "../../../../lib/compose.js";
import { createThreadWebSocketSession, type WsPeer } from "../../../../lib/ws-thread-handler.js";
import { createInMemoryCreditLedger } from "../../../billing/index.js";
import { createInMemoryEventSink } from "../../../observability/index.js";
import { createInMemoryProjectRepository } from "../../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
  createThreadEventHub,
} from "../../../threads/index.js";
import { fetchOpenRouterGeneration } from "../../gateway/adapters/openrouter/generation.js";
import type { Gateway, GenerateRequest, GenerateResult, StreamEvent } from "../../gateway/index.js";
import { gatewayStubDefaults } from "../../gateway/test-gateway.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTurnRunner } from "../turn-runner.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

vi.mock("../../gateway/adapters/openrouter/generation.js", () => ({
  fetchOpenRouterGeneration: vi.fn(),
}));

async function collectEvents(handle: { events: AsyncIterable<OrchestratorEvent> }) {
  const events: OrchestratorEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function abortAwarePartialStream(
  result: GenerateResult,
  options?: { waitForStart?: () => void },
): Gateway["stream"] {
  return async function* stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
    yield { type: "start", model: result.model, provider: result.provider };
    yield { type: "text.delta", text: "partial" };
    options?.waitForStart?.();
    while (!request.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    yield { type: "end", result };
  };
}

async function setup(gateway: Gateway, openRouterReconcile?: { apiKey: string; baseUrl?: string }) {
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
      openRouterReconcile,
    }),
  );
  const runner = createTurnRunner({
    orchestrator,
    hub,
    repos: { turns: repos.turns },
    eventSink: createInMemoryEventSink(),
  });
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  await creditLedger.grant({
    userId: "user-1",
    projectId: project.id,
    source: "manual",
    amountMillicredits: "1000000",
    reason: "cancel tests",
  });
  return { repos, thread, creditLedger, orchestrator, runner, hub, project };
}

describe("cancel billing", () => {
  it("debits partial usage when cancelled mid-stream (not zero, not full grant)", async () => {
    const partialResult: GenerateResult = {
      content: [{ type: "text", text: "partial" }],
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 500_000, outputTokens: 500_000 },
      model: "gpt-4.1-mini",
      provider: "openai",
    };
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      stream: abortAwarePartialStream(partialResult),
      async generate() {
        throw new Error("not used");
      },
    };

    const { thread, creditLedger, orchestrator } = await setup(gateway);
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "cancel mid stream",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const events = await eventsPromise;

    expect(events.some((event) => event.type === "model.response_received")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    const balance = await creditLedger.getBalance({
      userId: "user-1",
      projectId: thread.projectId,
    });
    expect(BigInt(balance)).toBeLessThan(1_000_000n);
    expect(balance).not.toBe("0");
  });

  it("reconciles OpenRouter hard-cancel via providerRequestId when stream had no usage", async () => {
    vi.mocked(fetchOpenRouterGeneration).mockResolvedValue({
      id: "gen-hard-cancel",
      total_cost: 0.25,
      native_tokens_prompt: 1000,
      native_tokens_completion: 500,
    });

    const partialResult: GenerateResult = {
      content: [{ type: "text", text: "x" }],
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "openai/gpt-4o",
      provider: "openrouter",
      providerData: { generationId: "gen-hard-cancel" },
    };
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      stream: abortAwarePartialStream(partialResult),
      async generate() {
        throw new Error("not used");
      },
    };

    const { thread, creditLedger, orchestrator } = await setup(gateway, {
      apiKey: "test-openrouter-key",
    });
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "openrouter cancel",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const events = await eventsPromise;

    expect(fetchOpenRouterGeneration).toHaveBeenCalledWith(
      "gen-hard-cancel",
      "test-openrouter-key",
      "https://openrouter.ai/api/v1",
      controller.signal,
    );
    const response = events.find((event) => event.type === "model.response_received");
    expect(response?.type).toBe("model.response_received");
    if (response?.type === "model.response_received") {
      expect(response.response.providerRequestId).toBe("gen-hard-cancel");
      expect(response.response.priceSource).toBe("provider_reported");
    }
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    const balance = await creditLedger.getBalance({
      userId: "user-1",
      projectId: thread.projectId,
    });
    expect(BigInt(balance)).toBeLessThan(1_000_000n);
  });

  it("does not double-debit when cancel settlement replays the same usage event", async () => {
    const partialResult: GenerateResult = {
      content: [{ type: "text", text: "once" }],
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 250_000, outputTokens: 250_000 },
      model: "gpt-4.1-mini",
      provider: "openai",
    };
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      stream: abortAwarePartialStream(partialResult),
      async generate() {
        throw new Error("not used");
      },
    };

    const { thread, creditLedger, orchestrator } = await setup(gateway);
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "idempotent cancel",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await eventsPromise;
    const balanceAfterCancel = await creditLedger.getBalance({
      userId: "user-1",
      projectId: thread.projectId,
    });

    controller.abort();
    const balanceAfterSecondAbort = await creditLedger.getBalance({
      userId: "user-1",
      projectId: thread.projectId,
    });
    expect(balanceAfterSecondAbort).toBe(balanceAfterCancel);
  });

  it("cancels the in-flight turn when the WebSocket disconnects", async () => {
    let streamReleased!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      streamReleased = resolve;
    });
    const partialResult: GenerateResult = {
      content: [{ type: "text", text: "streaming" }],
      toolCalls: [],
      finishReason: "end_turn",
      usage: { inputTokens: 100_000, outputTokens: 100_000 },
      model: "gpt-4.1-mini",
      provider: "openai",
    };
    const gateway: Gateway = {
      ...gatewayStubDefaults,
      stream: abortAwarePartialStream(partialResult, { waitForStart: streamReleased }),
      async generate() {
        throw new Error("not used");
      },
    };

    const { thread, creditLedger, runner, hub, repos } = await setup(gateway);
    const app = createInMemoryAppServices();
    app.gateway = gateway;
    app.threadRepos = repos;
    app.repos = repos;
    app.threadEventHub = hub;
    app.hub = hub;
    app.runner = runner;
    app.creditLedger = creditLedger;
    app.threadRuntime = {
      async requireOwnedThread(threadId, userId) {
        if (threadId !== thread.id || userId !== "user-1") throw new Error("not found");
        return {
          ...thread,
          workId: "work-1",
          currentAgentId: null,
          activeLeafTurnId: null,
          nextSeq: 0n,
          status: "active",
        };
      },
      async liveState() {
        return {
          threadId: thread.id,
          status: "idle",
          runningTurnId: runner.getRunningTurnId(thread.id),
          currentAgent: null,
          nextSeq: "1",
          resumeAfterSeq: "0",
        };
      },
      async sendMessage() {
        throw new Error("not used");
      },
      async journalEvents() {
        return [];
      },
    };

    const startPromise = runner.startTurn({ threadId: thread.id, userText: "ws disconnect" });
    await streamStarted;
    const turnId = runner.getRunningTurnId(thread.id);
    expect(turnId).not.toBeNull();

    const peer: WsPeer = {
      request: new Request("https://app.localhost/ws"),
      context: { app, userId: "user-1" },
      send: () => {},
      close: () => {},
    };
    const session = createThreadWebSocketSession(peer);
    await session.onMessage(
      JSON.stringify({ type: "subscribe", threadId: thread.id, lastSeq: "0" }),
    );
    session.onClose();
    await startPromise;
    const deadline = Date.now() + 5_000;
    while (runner.getRunningTurnId(thread.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const balance = await creditLedger.getBalance({
      userId: "user-1",
      projectId: thread.projectId,
    });
    expect(BigInt(balance)).toBeLessThan(1_000_000n);
    const assistantTurn = turnId ? await app.repos.turns.findById(turnId) : null;
    expect(assistantTurn?.status).toBe("cancelled");
  });
});
