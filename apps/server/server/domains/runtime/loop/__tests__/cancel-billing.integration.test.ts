/**
 * Cancel billing integration tests: soft-cancel debits consumed usage through
 * the real createGateway path and explicit cancel remains idempotent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
