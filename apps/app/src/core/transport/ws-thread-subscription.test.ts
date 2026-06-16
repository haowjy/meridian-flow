import { describe, expect, it, vi } from "vitest";

import { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

describe("WsThreadSubscriptionRegistry.ensure", () => {
  it("subscribes on first handler with an explicit cursor", () => {
    const registry = new WsThreadSubscriptionRegistry();
    const result = registry.ensure("thread_1", { onEvent: vi.fn() }, "5");

    expect(result.sendSubscribe).toBe(true);
    expect(result.forceSubscribe).toBe(true);
    expect(result.subscription.lastSeq).toBe("5");
    expect(result.subscription.serverSubscribed).toBe(false);
  });

  it("rewinds lastSeq and forces subscribe when a new run passes an older cursor", () => {
    const registry = new WsThreadSubscriptionRegistry();
    const handlerA = { onEvent: vi.fn() };
    registry.ensure("thread_1", handlerA, "5");
    const sub = registry.get("thread_1");
    if (!sub) throw new Error("expected subscription");
    sub.lastSeq = "8";
    sub.serverSubscribed = true;

    const result = registry.ensure("thread_1", { onEvent: vi.fn() }, "3");

    expect(result.subscription.lastSeq).toBe("3");
    expect(result.subscription.serverSubscribed).toBe(false);
    expect(result.sendSubscribe).toBe(true);
    expect(result.forceSubscribe).toBe(true);
  });

  it("skips subscribe when cursor unchanged and server already subscribed", () => {
    const registry = new WsThreadSubscriptionRegistry();
    const handlerA = { onEvent: vi.fn() };
    registry.ensure("thread_1", handlerA, "5");
    const sub = registry.get("thread_1");
    if (!sub) throw new Error("expected subscription");
    sub.serverSubscribed = true;

    const result = registry.ensure("thread_1", { onEvent: vi.fn() }, "5");

    expect(result.sendSubscribe).toBe(false);
    expect(result.forceSubscribe).toBe(false);
  });

  it("subscribes when adding a handler without a cursor and server is not subscribed", () => {
    const registry = new WsThreadSubscriptionRegistry();
    registry.ensure("thread_1", { onEvent: vi.fn() }, "1");
    const sub = registry.get("thread_1");
    if (!sub) throw new Error("expected subscription");
    sub.serverSubscribed = false;

    const result = registry.ensure("thread_1", { onEvent: vi.fn() });

    expect(result.sendSubscribe).toBe(true);
    expect(result.forceSubscribe).toBe(false);
  });
});
