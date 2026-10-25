/**
 * Regression contract for the gap ↔ resubscribe storm.
 *
 * A thread whose journal outgrows the server replay cap makes the transport
 * request forever from the same unreplayable cursor. These tests drive the
 * real `ThreadSocketClient` against a fake server that models the cap: any
 * subscribe at/below the capped window answers `gap`, anything beyond answers
 * `subscribed`. The transport must move its resume point to the gap's `toSeq`
 * and converge after a single resubscribe.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Replay-gap cursor recovery (kb/decisions/platform/client/chat-sync-boundaries.md)
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeThreadSocket } from "../test-support/fake-thread-socket";

const { ThreadSocketClient } = await import("./thread-socket-client");

const THREAD_ID = "thread-1";
const CAP_WINDOW_SEQ = 10_000_999n; // end cursor of the oldest replayable window
const HEAD_SEQ = 23_081_999n; // server journal head cursor

const LIVE_STATE = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  runningTurnId: null,
  activity: { children: [] },
  pending: { items: [] },
  runState: {
    version: "1",
    items: [],
    sentThrough: 0,
    execution: null,
    mode: "direct" as const,
    blocked: null,
  },
};

type FakeFrame = { type?: string; requestId?: string; threadId?: string; lastSeq?: string };

function createHarness(maxResubscribes = 5) {
  const subscribeFrames: FakeFrame[] = [];
  const gapEvents: Array<{ toSeq?: string; cause?: string }> = [];
  const deliveredEvents: string[] = [];
  let socket: FakeThreadSocket | null = null;

  const answer = (
    target: FakeThreadSocket,
    requestId: string,
    lastSeq: string | undefined,
  ): void => {
    const after = lastSeq ?? HEAD_SEQ.toString();
    if (BigInt(after) <= CAP_WINDOW_SEQ) {
      target.deliver({
        type: "gap",
        requestId,
        threadId: THREAD_ID,
        cause: "replay_limit_exceeded",
        fromSeq: after,
        toSeq: HEAD_SEQ.toString(),
        message: "Journal replay capped at 10000 events",
      });
      return;
    }

    target.deliver({
      type: "subscribed",
      requestId,
      threadId: THREAD_ID,
      after,
      catchup: [{ seq: "1", event: { type: EventType.RAW, event: {} }, sourceThreadId: THREAD_ID }],
      state: LIVE_STATE,
    });
  };

  const respond = (target: FakeThreadSocket, rawFrame: unknown): void => {
    const frame = rawFrame as FakeFrame;
    if (frame.type !== "subscribe") return;

    subscribeFrames.push(frame);
    // Stop answering once a runaway loop passes the bound so a pre-fix failure
    // is a clean assertion, not an unbounded synchronous recursion.
    if (subscribeFrames.length > maxResubscribes) return;

    answer(target, frame.requestId ?? "", frame.lastSeq);
  };

  const transport = new ThreadSocketClient({
    url: () => "ws://test/api/threads/ws",
    toError: (error) => new Error(error.message),
    cancelTurn: vi.fn(),
    webSocketFactory: () => {
      socket = new FakeThreadSocket(respond);
      return socket;
    },
  });

  const handlers = {
    onEvent: (event: { seq: string }) => deliveredEvents.push(event.seq),
    onGap: (event: { toSeq?: string; cause?: string }) => gapEvents.push(event),
  };

  const unsubscribe = transport.subscribe(THREAD_ID, handlers, { after: "0" });
  const activeSocket = socket as unknown as FakeThreadSocket;
  activeSocket.open();
  activeSocket.deliver({
    type: "connected",
    userId: "user-1",
    scope: { type: "standalone" },
    serverVersion: "0.0.0",
    connectionToken: "token-1",
  });

  return {
    transport,
    socket: activeSocket,
    subscribeFrames,
    gapEvents,
    deliveredEvents,
    unsubscribe,
  };
}

describe("ThreadSocketClient gap recovery", () => {
  it("does not resume past a head advertised without a delivered event", () => {
    const requests: FakeFrame[] = [];
    let socket: FakeThreadSocket | null = null;
    const transport = new ThreadSocketClient({
      url: () => "ws://test/api/threads/ws",
      toError: (error) => new Error(error.message),
      cancelTurn: vi.fn(),
      webSocketFactory: () => {
        socket = new FakeThreadSocket((_target, frame) => {
          if ((frame as FakeFrame).type === "subscribe") requests.push(frame as FakeFrame);
        });
        return socket;
      },
    });
    const unsubscribe = transport.subscribe(THREAD_ID, { onEvent: () => {} }, { after: "0" });
    const activeSocket = socket as unknown as FakeThreadSocket;
    activeSocket.open();
    const connected = {
      type: "connected",
      userId: "user-1",
      scope: { type: "standalone" },
      serverVersion: "0.0.0",
      connectionToken: "token-1",
    };
    activeSocket.deliver(connected);
    activeSocket.deliver({
      type: "subscribed",
      requestId: requests[0]?.requestId,
      threadId: THREAD_ID,
      after: "0",
      catchup: [],
      state: LIVE_STATE,
    });

    // A reconnect's cursor is event-delivery state, not the durable head.
    activeSocket.deliver(connected);
    expect(requests.at(-1)?.lastSeq).toBe("0");
    unsubscribe();
    transport.disconnect();
  });

  it("advances the resume point to the gap head and converges after one resubscribe", () => {
    const harness = createHarness();
    try {
      // The explicit zero cursor requests history → gap. The transport must then
      // resubscribe from toSeq exactly once; the follow-up is beyond the cap.
      expect(harness.subscribeFrames).toHaveLength(2);
      expect(harness.subscribeFrames[0]?.lastSeq).toBe("0");
      expect(harness.subscribeFrames[1]?.lastSeq).toBe(HEAD_SEQ.toString());
      expect(harness.gapEvents).toEqual([expect.objectContaining({ toSeq: HEAD_SEQ.toString() })]);
      // The truncated catch-up is skipped, not replayed onto the reducer.
      expect(harness.deliveredEvents).toEqual([]);
    } finally {
      harness.unsubscribe();
      harness.transport.disconnect();
    }
  });
});
