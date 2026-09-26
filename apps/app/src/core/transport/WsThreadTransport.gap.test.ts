/**
 * Regression contract for the gap ↔ resubscribe storm.
 *
 * A thread whose journal outgrows the server replay cap makes the transport
 * resubscribe forever from the same unreplayable cursor. These tests drive the
 * real `WsThreadTransport` against a fake server that models the cap: any
 * subscribe at/below the capped window answers `gap`, anything beyond answers
 * `subscribed`. The transport must move its resume point to the gap's `toSeq`
 * and converge after a single resubscribe.
 */
import { EventType } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeThreadSocket } from "./test-support/FakeThreadSocket";

vi.mock("./dev-transport", () => ({
  buildThreadsWsUrl: () => "ws://test/api/threads/ws",
}));

const { WsThreadTransport } = await import("./WsThreadTransport");

const THREAD_ID = "thread-1";
const CAP_WINDOW_SEQ = 10_000_999n; // end cursor of the oldest replayable window
const HEAD_SEQ = 23_081_999n; // server journal head cursor

const LIVE_STATE = {
  threadId: THREAD_ID,
  status: { kind: "asleep" as const },
  runningTurnId: null,
  activity: { descendants: [] },
  pending: { items: [] },
  resumeAfterSeq: "1",
};

type FakeFrame = { type?: string; threadId?: string; lastSeq?: string; subscriptions?: unknown };

/**
 * Minimal in-memory WebSocket that hands every client frame to the fake server
 * and lets the server push a reply back synchronously. `MAX_REPLIES` bounds a
 * pre-fix runaway loop so the assertion fails instead of recursing forever.
 */
function isBeyondCap(lastSeq: string | undefined): boolean {
  return lastSeq !== undefined && BigInt(lastSeq) > CAP_WINDOW_SEQ;
}

function createHarness(maxResubscribes = 5) {
  const subscribeFrames: FakeFrame[] = [];
  const gapEvents: Array<{ toSeq?: string; cause?: string }> = [];
  const deliveredEvents: string[] = [];
  let socket: FakeThreadSocket | null = null;

  const answer = (target: FakeThreadSocket, lastSeq: string | undefined): void => {
    if (!isBeyondCap(lastSeq)) {
      target.deliver({
        type: "gap",
        threadId: THREAD_ID,
        cause: "replay_limit_exceeded",
        fromSeq: lastSeq ?? "0",
        toSeq: HEAD_SEQ.toString(),
        message: "Journal replay capped at 10000 events",
      });
    }

    target.deliver({
      type: "subscribed",
      threadId: THREAD_ID,
      catchup: [{ seq: "1", event: { type: EventType.RAW, event: {} }, sourceThreadId: THREAD_ID }],
      state: LIVE_STATE,
    });
  };

  const respond = (target: FakeThreadSocket, rawFrame: unknown): void => {
    const frame = rawFrame as FakeFrame;
    if (frame.type === "resume") {
      const first = (frame.subscriptions as FakeFrame[] | undefined)?.[0];
      answer(target, first?.lastSeq);
      return;
    }
    if (frame.type !== "subscribe") return;

    subscribeFrames.push(frame);
    // Stop answering once a runaway loop passes the bound so a pre-fix failure
    // is a clean assertion, not an unbounded synchronous recursion.
    if (subscribeFrames.length > maxResubscribes) return;

    answer(target, frame.lastSeq);
  };

  const transport = new WsThreadTransport({
    webSocketFactory: () => {
      socket = new FakeThreadSocket(respond);
      return socket as unknown as WebSocket;
    },
  });

  const handlers = {
    onEvent: (event: { seq: string }) => deliveredEvents.push(event.seq),
    onGap: (event: { toSeq?: string; cause?: string }) => gapEvents.push(event),
  };

  const unsubscribe = transport.subscribe(THREAD_ID, handlers);
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

describe("WsThreadTransport gap recovery", () => {
  it("does not resume past a head advertised without a delivered event", () => {
    const resumes: Array<{ subscriptions?: Array<{ lastSeq?: string }> }> = [];
    let socket: FakeThreadSocket | null = null;
    const transport = new WsThreadTransport({
      webSocketFactory: () => {
        socket = new FakeThreadSocket((_target, frame) => {
          if ((frame as { type?: string }).type === "resume") {
            resumes.push(frame as { subscriptions?: Array<{ lastSeq?: string }> });
          }
        });
        return socket as unknown as WebSocket;
      },
    });
    const unsubscribe = transport.subscribe(THREAD_ID, { onEvent: () => {} });
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
      threadId: THREAD_ID,
      catchup: [],
      state: LIVE_STATE,
    });

    // A reconnect's resume cursor is event-delivery state, not the durable head.
    activeSocket.deliver(connected);
    expect(resumes.at(-1)?.subscriptions?.[0]?.lastSeq).toBe("0");
    unsubscribe();
    transport.disconnect();
  });

  it("advances the resume point to the gap head and converges after one resubscribe", () => {
    const harness = createHarness();
    try {
      // The initial resume replays from 0 → gap. The transport must then
      // resubscribe from toSeq exactly once; the follow-up is beyond the cap.
      expect(harness.subscribeFrames).toHaveLength(1);
      expect(harness.subscribeFrames[0]?.lastSeq).toBe(HEAD_SEQ.toString());
      expect(harness.gapEvents).toEqual([expect.objectContaining({ toSeq: HEAD_SEQ.toString() })]);
      // The truncated catch-up is skipped, not replayed onto the reducer.
      expect(harness.deliveredEvents).toEqual([]);
    } finally {
      harness.unsubscribe();
      harness.transport.disconnect();
    }
  });
});
