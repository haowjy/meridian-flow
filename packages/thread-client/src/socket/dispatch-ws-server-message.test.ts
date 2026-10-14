/** WS message dispatch contracts for interruption settlement and subscription replay. */
import type { MeridianError } from "@meridian/contracts/interrupt";
import type { WsServerMessage } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchWsServerMessage,
  type WsServerMessageDispatchDeps,
} from "./dispatch-ws-server-message";
import { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

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
  const subscriptions = { get: vi.fn(() => undefined) } as unknown as WsThreadSubscriptionRegistry;
  const deps: WsServerMessageDispatchDeps = {
    subscriptions,
    toError: vi.fn((error) => Object.assign(new Error(error.message), { code: error.code })),
    dispatchSequencedEvent: vi.fn(),
    resubscribe: vi.fn(),
    handleGap: vi.fn(),
    send: vi.fn(),
    onConnected: vi.fn(),
    onThreadError,
    onGlobalError,
    onInterruptResponseError,
  };
  return { deps, onInterruptResponseError, onThreadError, onGlobalError };
}

function subscribedMessage(): WsServerMessage {
  return {
    type: "subscribed",
    threadId: "thread-1",
    catchup: [{ seq: "1", event: { type: "RAW", event: {} }, sourceThreadId: "thread-1" }],
    state: {
      threadId: "thread-1",
      status: { kind: "asleep" },
      runningTurnId: null,
      activity: { children: [] },
      pending: { items: [] },
      runState: {
        version: "1",
        items: [],
        sentThrough: 0,
        execution: null,
        mode: "direct",
        blocked: null,
      },
      resumeAfterSeq: "1",
    },
  } as unknown as WsServerMessage;
}

describe("dispatchWsServerMessage", () => {
  it.each([
    "interrupt_not_pending",
    "interrupt_correlation_mismatch",
  ])("routes %s to the interrupt settlement owner instead of dropping it", (code) => {
    const { deps, onInterruptResponseError, onThreadError, onGlobalError } = makeDeps();
    dispatchWsServerMessage(errorFrame(code), deps);
    expect(onInterruptResponseError).toHaveBeenCalledTimes(1);
    const [threadId, error] = onInterruptResponseError.mock.calls[0] as [string, Error];
    expect(threadId).toBe("thread-1");
    expect(error).toBe(vi.mocked(deps.toError).mock.results[0].value);
    expect((error as unknown as { code: string }).code).toBe(code);
    expect(onThreadError).not.toHaveBeenCalled();
    expect(onGlobalError).not.toHaveBeenCalled();
  });

  it("still routes unrelated error frames to the thread error sink", () => {
    const { deps, onInterruptResponseError, onThreadError } = makeDeps();
    dispatchWsServerMessage(errorFrame("internal"), deps);
    expect(onInterruptResponseError).not.toHaveBeenCalled();
    expect(onThreadError).toHaveBeenCalledWith("thread-1", expect.any(Error));
  });

  it("gives each handler every event after its own cursor once, in order, across a rewind race", () => {
    const subscriptions = new WsThreadSubscriptionRegistry();
    const seen = { current: [] as string[], late: [] as string[] };
    const order: string[] = [];
    const current = {
      onEvent: (e: { seq: string }) => {
        seen.current.push(e.seq);
        order.push("event");
      },
      onLiveState: () => order.push("live-state"),
    };
    const late = {
      onEvent: (e: { seq: string }) => {
        seen.late.push(e.seq);
        order.push("event");
      },
      onLiveState: () => order.push("live-state"),
    };
    subscriptions.ensure("thread-1", current, "3000");
    // The late handler rewinds to 1000: the client sends a subscribe and fences it.
    const rewind = subscriptions.ensure("thread-1", late, "1000");
    subscriptions.holdForReplay(rewind.subscription, rewind.waiters);
    rewind.subscription.replayInFlight = true;

    // Live frames land before the server answers; the catch-up covers them.
    const frame = (seq: string) => ({
      seq,
      event: { type: "RAW", event: {} },
      sourceThreadId: "thread-1",
    });
    for (const seq of ["4000", "5000", "6000", "7000"]) {
      subscriptions.accept("thread-1", frame(seq) as never);
    }
    expect(seen.late).toEqual([]);
    const catchup = ["2000", "3000", "4000", "5000", "6000", "7000"].map(frame);
    const message = { ...subscribedMessage(), catchup } as unknown as WsServerMessage;
    dispatchWsServerMessage(message, {
      subscriptions,
      toError: (error) => Object.assign(new Error(error.message), { code: error.code }),
      dispatchSequencedEvent: vi.fn(),
      resubscribe: vi.fn(),
      handleGap: vi.fn(),
      send: vi.fn(),
      onConnected: vi.fn(),
      onThreadError: vi.fn(),
      onGlobalError: vi.fn(),
      onInterruptResponseError: vi.fn(),
    });
    expect(seen.late).toEqual(["2000", "3000", "4000", "5000", "6000", "7000"]);
    expect(seen.current).toEqual(["4000", "5000", "6000", "7000"]);
    // Live state lands after every catch-up frame.
    expect(order.slice(-2)).toEqual(["live-state", "live-state"]);
    expect(order.indexOf("live-state")).toBe(order.length - 2);
  });
});
