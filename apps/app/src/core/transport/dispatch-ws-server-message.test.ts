/**
<<<<<<< HEAD
 * Contract tests for WS error-frame routing.
 *
 * Non-fatal interrupt-response rejections (`interrupt_not_pending`,
 * `interrupt_correlation_mismatch`) are an allowed pause/resume race. They must
 * reach the interrupt settlement owner instead of being dropped, and must never
 * fan out as a thread/generic error that tears the subscription down.
 */
import type { MeridianError } from "@meridian/contracts/interrupt";
import type { WsServerMessage } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { isMeridianApiError } from "@/client/api/meridian-error";

import {
  dispatchWsServerMessage,
  type WsServerMessageDispatchDeps,
} from "./dispatch-ws-server-message";
import type { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

function errorFrame(
  code: string,
  threadId = "thread-1",
): Extract<WsServerMessage, { type: "error" }> {
  const error: MeridianError = {
    code,
    message: `frame: ${code}`,
    retryable: false,
    source: "system",
  };
  return { type: "error", kind: "error", error, threadId };
}

function makeDeps() {
  const onInterruptResponseError = vi.fn();
  const onThreadError = vi.fn();
  const onGlobalError = vi.fn();
  const subscriptions = {
    get: vi.fn(() => undefined),
  } as unknown as WsThreadSubscriptionRegistry;
  const deps: WsServerMessageDispatchDeps = {
    subscriptions,
    dispatchSequencedEvent: vi.fn(),
    handleGap: vi.fn(),
    send: vi.fn(),
    onConnected: vi.fn(),
    onThreadError,
    onGlobalError,
    onInterruptResponseError,
  };
  return { deps, onInterruptResponseError, onThreadError, onGlobalError };
}

describe("dispatchWsServerMessage interrupt response errors", () => {
  it.each([
    "interrupt_not_pending",
    "interrupt_correlation_mismatch",
  ])("routes %s to the interrupt settlement owner instead of dropping it", (code) => {
    const { deps, onInterruptResponseError, onThreadError, onGlobalError } = makeDeps();

    dispatchWsServerMessage(errorFrame(code), deps);

    expect(onInterruptResponseError).toHaveBeenCalledTimes(1);
    const [threadId, error] = onInterruptResponseError.mock.calls[0] as [string, Error];
    expect(threadId).toBe("thread-1");
    expect(isMeridianApiError(error)).toBe(true);
    expect((error as unknown as { code: string }).code).toBe(code);
    expect(onThreadError).not.toHaveBeenCalled();
    expect(onGlobalError).not.toHaveBeenCalled();
  });

  it("still routes unrelated error frames to the thread error sink", () => {
    const { deps, onInterruptResponseError, onThreadError } = makeDeps();

    dispatchWsServerMessage(errorFrame("internal"), deps);

    expect(onInterruptResponseError).not.toHaveBeenCalled();
    expect(onThreadError).toHaveBeenCalledWith("thread-1", expect.any(Error));
=======
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
>>>>>>> d5ee84994 (feat(app): live recursive running-subagents strip (3.5 F2))
  });
});
