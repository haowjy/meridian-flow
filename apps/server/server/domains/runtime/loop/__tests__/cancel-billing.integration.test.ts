/** Real-gateway partial-cancel billing and non-cancelling WebSocket disconnects. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createThreadWebSocketSession, type WsPeer } from "../../../../lib/ws-thread-handler.js";
import { createInMemoryWorkRepository } from "../../../projects/adapters/work-repository/in-memory.js";
import { deleteWorkTransition } from "../../../projects/index.js";
import {
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
} from "../../gateway/adapters/mock/server.js";
import { createGateway } from "../../gateway/create-gateway.js";
import type { Gateway } from "../../gateway/index.js";
import { runtimeScenario } from "./runtime-harness.js";

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
            tokenizer: "o200k",
            displayName: "GPT-4.1 Mini",
            contextWindow: 128_000,
            maxOutputTokens: 4096,
            promptCache: { kind: "none", ttlMs: null },
            capabilities: new Set(["streaming"]),
          },
        ],
      },
    ],
    defaultModel: "gpt-4.1-mini",
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
  });
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
    const rig = await runtimeScenario({ gateway: createMockGateway(mock) });
    const controller = new AbortController();
    const handle = await rig.orchestrator.prepare({
      threadId: rig.thread.id,
      userText: "cancel billing",
      signal: controller.signal,
    });
    const eventsPromise = rig.execute(handle);
    await rig.gatewaySignal.promise;
    controller.abort();
    const { events, outcome } = await eventsPromise;
    expect(outcome.status).toBe("cancelled");

    expect(events.some((event) => event.type === "model.response_received")).toBe(true);
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);
    const balance = await rig.balance();
    expect(BigInt(balance)).toBeLessThan(1_200_000n);
    expect(balance).not.toBe("1200000");
  });

  it("does not cancel a running turn when a subscribed WebSocket disconnects", async () => {
    const rig = await runtimeScenario({ gateway: createMockGateway(mock) });
    const app = rig.createAppServices();

    await rig.inbox.enqueue({
      threadId: rig.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: rig.userId },
      body: { kind: "text", text: "cancel billing" },
      idempotencyKey: "cancel-billing-ws-disconnect",
    });
    await rig.runner.startDrain(rig.thread.id);
    await rig.gatewaySignal.promise;
    const turnId = await rig.runClaim.readRunningTurnId(rig.thread.id);
    expect(turnId).not.toBeNull();

    const peer: WsPeer = {
      request: new Request("https://app.localhost/ws-unrelated"),
      context: { app, userId: rig.userId, traceId: "test-ws-trace" },
      send: () => {},
      close: () => {},
    };
    const session = createThreadWebSocketSession(peer);
    session.open();
    await session.onMessage(
      JSON.stringify({ type: "subscribe", threadId: rig.thread.id, lastSeq: "0" }),
    );
    session.onClose();

    expect(await rig.runClaim.readRunningTurnId(rig.thread.id)).toBe(turnId);

    await app.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    expect(await rig.awaitCancelled(turnId as NonNullable<typeof turnId>)).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancels an active chat run after its Work is deleted", async () => {
    const rig = await runtimeScenario({ gateway: createMockGateway(mock) });
    const memoryWorks = createInMemoryWorkRepository();
    const work = await memoryWorks.create({
      projectId: rig.project.id as never,
      name: "Active run",
    });
    const softDelete = memoryWorks.softDelete.bind(memoryWorks);
    const works = {
      ...memoryWorks,
      async softDelete(workId: Parameters<typeof memoryWorks.softDelete>[0]) {
        return { ...(await softDelete(workId)), threadIds: [rig.thread.id as never] };
      },
    };

    await rig.inbox.enqueue({
      threadId: rig.thread.id,
      intent: "message",
      provenance: { kind: "writer", actorId: rig.userId },
      body: { kind: "text", text: "delete while running" },
      idempotencyKey: "work-delete-active-run",
    });
    await rig.startDrain(rig.thread.id);
    await rig.gatewaySignal.promise;
    const turnId = await rig.runClaim.readRunningTurnId(rig.thread.id);
    expect(turnId).not.toBeNull();

    await deleteWorkTransition(
      {
        works,
        async stopThreadRun(threadId) {
          const runningTurnId = await rig.runClaim.readRunningTurnId(threadId);
          if (runningTurnId) await rig.runner.cancel(threadId, runningTurnId);
        },
      },
      work.id,
    );

    await expect(rig.awaitCancelled(turnId as NonNullable<typeof turnId>)).resolves.toMatchObject({
      status: "cancelled",
    });
  });
});
