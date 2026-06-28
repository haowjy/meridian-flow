/**
 * Cancel billing integration tests: soft-cancel drain debits consumed usage through
 * the real createGateway path, explicit cancel remains idempotent, and WS
 * disconnects do not cancel in-flight turns.
 */

import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import {
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
} from "../../gateway/adapters/mock/server.js";
import { createGateway } from "../../gateway/create-gateway.js";
import type { Gateway } from "../../gateway/index.js";
import { createToolExecutor, createToolRegistry } from "../../tools/index.js";
import { createCheckpointRegistry } from "../checkpoints.js";
import { createOrchestrator } from "../orchestrator.js";
import { createTurnRunner } from "../turn-runner.js";
import { createTestOrchestratorDeps } from "./test-orchestrator-deps.js";

async function collectEvents(handle: { events: AsyncIterable<OrchestratorEvent> }) {
  const events: OrchestratorEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function createMockGateway(mock: MockOpenAIServer): Gateway {
  return createGateway({
    providers: [
      {
        id: "openai",
        adapter: "openai-compatible",
        baseUrl: mock.baseUrl,
        models: [
          {
            id: "gpt-4.1-mini",
            provider: "openai",
            displayName: "GPT-4.1 Mini",
            contextWindow: 128_000,
            maxOutputTokens: 4096,
            capabilities: new Set(["streaming"]),
          },
        ],
      },
    ],
    defaultModel: "gpt-4.1-mini",
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

async function waitForStreamStart() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("cancel billing", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("debits partial usage when cancelled mid-stream through createGateway", async () => {
    const { thread, creditLedger, orchestrator } = await setup(createMockGateway(mock));
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "cancel billing",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await waitForStreamStart();
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

  it("does not double-debit when cancel settlement replays the same usage event", async () => {
    const { thread, creditLedger, orchestrator } = await setup(createMockGateway(mock));
    const controller = new AbortController();
    const handle = await orchestrator.runTurn({
      threadId: thread.id,
      userText: "cancel billing",
      signal: controller.signal,
    });
    const eventsPromise = collectEvents(handle);
    await waitForStreamStart();
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

  it("does not cancel the in-flight turn when the owning WebSocket disconnects before subscribe", async () => {
    const gateway = createMockGateway(mock);
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

    let ownerConnectionToken = "";
    const ownerPeer: WsPeer = {
      request: new Request("https://app.localhost/ws"),
      context: { app, userId: "user-1" },
      send: (data) => {
        const frame = JSON.parse(data) as { type?: string; connectionToken?: string };
        if (frame.type === "connected" && frame.connectionToken) {
          ownerConnectionToken = frame.connectionToken;
        }
      },
      close: () => {},
    };
    const ownerSession = createThreadWebSocketSession(ownerPeer);
    ownerSession.open();
    expect(ownerConnectionToken.length).toBeGreaterThan(0);

    const startPromise = runner.startTurn({
      threadId: thread.id,
      userText: "cancel billing",
      connectionToken: ownerConnectionToken,
    });
    await waitForStreamStart();
    const turnId = runner.getRunningTurnId(thread.id);
    expect(turnId).not.toBeNull();

    ownerSession.onClose();
    expect(runner.getRunningTurnId(thread.id)).toBe(turnId);

    await app.runner.cancel(thread.id, turnId as NonNullable<typeof turnId>);
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

  it("does not cancel turns when another subscribed WebSocket disconnects", async () => {
    const gateway = createMockGateway(mock);
    const { thread, runner, hub, repos } = await setup(gateway);
    const app = createInMemoryAppServices();
    app.gateway = gateway;
    app.threadRepos = repos;
    app.repos = repos;
    app.threadEventHub = hub;
    app.hub = hub;
    app.runner = runner;
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

    let ownerConnectionToken = "";
    const ownerPeer: WsPeer = {
      request: new Request("https://app.localhost/ws-owner"),
      context: { app, userId: "user-1" },
      send: (data) => {
        const frame = JSON.parse(data) as { type?: string; connectionToken?: string };
        if (frame.type === "connected" && frame.connectionToken) {
          ownerConnectionToken = frame.connectionToken;
        }
      },
      close: () => {},
    };
    createThreadWebSocketSession(ownerPeer).open();

    const startPromise = runner.startTurn({
      threadId: thread.id,
      userText: "cancel billing",
      connectionToken: ownerConnectionToken,
    });
    await waitForStreamStart();
    const turnId = runner.getRunningTurnId(thread.id);
    expect(turnId).not.toBeNull();

    const spectatorPeer: WsPeer = {
      request: new Request("https://app.localhost/ws-spectator"),
      context: { app, userId: "user-1" },
      send: () => {},
      close: () => {},
    };
    const spectatorSession = createThreadWebSocketSession(spectatorPeer);
    spectatorSession.open();
    await spectatorSession.onMessage(
      JSON.stringify({ type: "subscribe", threadId: thread.id, lastSeq: "0" }),
    );
    spectatorSession.onClose();

    expect(runner.getRunningTurnId(thread.id)).toBe(turnId);

    await app.runner.cancel(thread.id, turnId as NonNullable<typeof turnId>);
    await startPromise;
  });

  it("does not cancel tokenless runs when a subscribed WebSocket disconnects", async () => {
    const gateway = createMockGateway(mock);
    const { thread, runner, hub, repos } = await setup(gateway);
    const app = createInMemoryAppServices();
    app.gateway = gateway;
    app.threadRepos = repos;
    app.repos = repos;
    app.threadEventHub = hub;
    app.hub = hub;
    app.runner = runner;
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

    const startPromise = runner.startTurn({
      threadId: thread.id,
      userText: "cancel billing",
    });
    await waitForStreamStart();
    const turnId = runner.getRunningTurnId(thread.id);
    expect(turnId).not.toBeNull();

    const peer: WsPeer = {
      request: new Request("https://app.localhost/ws-unrelated"),
      context: { app, userId: "user-1" },
      send: () => {},
      close: () => {},
    };
    const session = createThreadWebSocketSession(peer);
    session.open();
    await session.onMessage(
      JSON.stringify({ type: "subscribe", threadId: thread.id, lastSeq: "0" }),
    );
    session.onClose();

    expect(runner.getRunningTurnId(thread.id)).toBe(turnId);

    await app.runner.cancel(thread.id, turnId as NonNullable<typeof turnId>);
    await startPromise;
  });
});
