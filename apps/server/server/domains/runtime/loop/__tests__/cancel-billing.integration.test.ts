/**
 * Cancel billing integration tests: soft-cancel drain debits consumed usage through
 * the real createGateway path, explicit cancel remains idempotent, and WS
 * disconnects do not cancel in-flight turns.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createThreadWebSocketSession, type WsPeer } from "../../../../lib/ws-thread-handler.js";
import {
  createMockOpenAICompatibleServer,
  type MockOpenAIServer,
} from "../../gateway/adapters/mock/server.js";
import { createGateway } from "../../gateway/create-gateway.js";
import type { Gateway } from "../../gateway/index.js";
import { RuntimeTestRig } from "./runtime-test-rig.js";

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

describe("cancel billing", () => {
  let mock: MockOpenAIServer;

  beforeAll(async () => {
    mock = await createMockOpenAICompatibleServer();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("debits partial usage when cancelled mid-stream through createGateway", async () => {
    const rig = await RuntimeTestRig.create({ gateway: createMockGateway(mock) });
    const controller = new AbortController();
    const handle = await rig.orchestrator.runTurn({
      threadId: rig.thread.id,
      userText: "cancel billing",
      signal: controller.signal,
    });
    const eventsPromise = rig.collect(handle);
    await rig.gatewaySignal.promise;
    controller.abort();
    const events = await eventsPromise;

    expect(events.some((event) => event.type === "model.response_received")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.cancelled");
    const balance = await rig.balance();
    expect(BigInt(balance)).toBeLessThan(1_200_000n);
    expect(balance).not.toBe("1200000");
  });

  it("does not double-debit when cancel settlement replays the same usage event", async () => {
    const rig = await RuntimeTestRig.create({ gateway: createMockGateway(mock) });
    const controller = new AbortController();
    const handle = await rig.orchestrator.runTurn({
      threadId: rig.thread.id,
      userText: "cancel billing",
      signal: controller.signal,
    });
    const eventsPromise = rig.collect(handle);
    await rig.gatewaySignal.promise;
    controller.abort();
    await eventsPromise;
    const balanceAfterCancel = await rig.balance();

    controller.abort();
    const balanceAfterSecondAbort = await rig.balance();
    expect(balanceAfterSecondAbort).toBe(balanceAfterCancel);
  });

  it("does not cancel the in-flight turn when the owning WebSocket disconnects before subscribe", async () => {
    const rig = await RuntimeTestRig.create({ gateway: createMockGateway(mock) });
    const app = rig.createAppServices();

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

    await rig.runner.startTurn({
      threadId: rig.thread.id,
      userText: "cancel billing",
      connectionToken: ownerConnectionToken,
    });
    await rig.gatewaySignal.promise;
    const turnId = rig.runner.getRunningTurnId(rig.thread.id);
    expect(turnId).not.toBeNull();

    ownerSession.onClose();
    expect(rig.runner.getRunningTurnId(rig.thread.id)).toBe(turnId);

    await app.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    await rig.awaitCancelled(turnId as NonNullable<typeof turnId>);

    const balance = await rig.balance();
    expect(BigInt(balance)).toBeLessThan(1_200_000n);
    const assistantTurn = turnId ? await rig.turn(turnId) : null;
    expect(assistantTurn?.status).toBe("cancelled");
  });

  it("does not cancel turns when another subscribed WebSocket disconnects", async () => {
    const rig = await RuntimeTestRig.create({ gateway: createMockGateway(mock) });
    const app = rig.createAppServices();

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

    await rig.runner.startTurn({
      threadId: rig.thread.id,
      userText: "cancel billing",
      connectionToken: ownerConnectionToken,
    });
    await rig.gatewaySignal.promise;
    const turnId = rig.runner.getRunningTurnId(rig.thread.id);
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
      JSON.stringify({ type: "subscribe", threadId: rig.thread.id, lastSeq: "0" }),
    );
    spectatorSession.onClose();

    expect(rig.runner.getRunningTurnId(rig.thread.id)).toBe(turnId);

    await app.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    await rig.awaitCancelled(turnId as NonNullable<typeof turnId>);
  });

  it("does not cancel tokenless runs when a subscribed WebSocket disconnects", async () => {
    const rig = await RuntimeTestRig.create({ gateway: createMockGateway(mock) });
    const app = rig.createAppServices();

    await rig.runner.startTurn({
      threadId: rig.thread.id,
      userText: "cancel billing",
    });
    await rig.gatewaySignal.promise;
    const turnId = rig.runner.getRunningTurnId(rig.thread.id);
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
      JSON.stringify({ type: "subscribe", threadId: rig.thread.id, lastSeq: "0" }),
    );
    session.onClose();

    expect(rig.runner.getRunningTurnId(rig.thread.id)).toBe(turnId);

    await app.runner.cancel(rig.thread.id, turnId as NonNullable<typeof turnId>);
    await rig.awaitCancelled(turnId as NonNullable<typeof turnId>);
  });
});
