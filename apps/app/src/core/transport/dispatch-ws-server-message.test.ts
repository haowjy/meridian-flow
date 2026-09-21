/**
 * The WS dispatcher owns message → callback routing. These pin that a
 * `subscribed` frame replays catch-up first and then delivers the authoritative
 * live state, so a replayed activity frame cannot outrank it on reconnect.
 */
import type { WsServerMessage } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { dispatchWsServerMessage } from "./dispatch-ws-server-message";
import { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

function subscribedMessage(): WsServerMessage {
  return {
    type: "subscribed",
    threadId: "thread-1",
    catchup: [{ seq: "1", event: { type: "RAW", event: {} }, sourceThreadId: "thread-1" }],
    state: {
      threadId: "thread-1",
      status: { kind: "asleep" },
      runningTurnId: null,
      activity: { descendants: [] },
      pending: { items: [] },
      resumeAfterSeq: "1",
    },
    nextSeq: "2",
  } as unknown as WsServerMessage;
}

describe("dispatchWsServerMessage", () => {
  it("delivers live state after catch-up frames", () => {
    const subscriptions = new WsThreadSubscriptionRegistry();
    const order: string[] = [];
    subscriptions.ensure("thread-1", {
      onEvent: () => order.push("event"),
      onLiveState: () => order.push("live-state"),
    });

    dispatchWsServerMessage(subscribedMessage(), {
      subscriptions,
      dispatchSequencedEvent: () => order.push("event"),
      handleGap: vi.fn(),
      send: vi.fn(),
      onConnected: vi.fn(),
      onThreadError: vi.fn(),
      onGlobalError: vi.fn(),
    });

    expect(order).toEqual(["event", "live-state"]);
  });
});
