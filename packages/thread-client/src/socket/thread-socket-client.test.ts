import type { MeridianError } from "@meridian/contracts/interrupt";
/** Thread socket deadlines preserve delivered cursors through restart recovery. */
import { EventType, type SequencedEvent, type WsServerMessage } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeThreadSocket } from "../test-support/fake-thread-socket";
import {
  dispatchWsServerMessage,
  type WsServerMessageDispatchDeps,
} from "./dispatch-ws-server-message";
import type { ConnectivityHint, ConnectivityHintsPort } from "./socket-ports";
import { ThreadSocketClient } from "./thread-socket-client";
import type { ConnectionState } from "./thread-transport";
import { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const connected = {
  type: "connected",
  userId: "user-1",
  scope: { type: "standalone" },
  serverVersion: "0.0.0",
  connectionToken: "token-1",
};
const state = {
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
    mode: "direct" as const,
    blocked: null,
  },
  resumeAfterSeq: "100",
};
function delta(seq: string, text: string) {
  return {
    seq,
    event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply-1", delta: text },
    sourceThreadId: "thread-1",
  };
}
function setup(handshakeTimeoutMs?: number) {
  const sockets: FakeThreadSocket[] = [];
  const transport = new ThreadSocketClient({
    url: () => "ws://test/api/threads/ws",
    toError: (error) => new Error(error.message),
    cancelTurn: vi.fn(),
    handshakeTimeoutMs,
    webSocketFactory: () => {
      const socket = new FakeThreadSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const events: SequencedEvent[] = [];
  const onClose = vi.fn();
  transport.subscribe("thread-1", { onEvent: (event) => events.push(event), onClose });
  return { transport, sockets, events, onClose };
}

it.each([
  "connecting",
  "open awaiting connected",
])("recovers a reply when the restart handshake stalls %s and fences late events", (phase) => {
  const { transport, sockets, events, onClose } = setup();
  try {
    sockets[0].open();
    sockets[0].deliver(connected);
    sockets[0].deliver({ type: "subscribed", threadId: "thread-1", catchup: [], state });
    sockets[0].deliver({ type: "event", threadId: "thread-1", ...delta("1", "Early ") });
    sockets[0].close(1006);
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
    const stalled = sockets[1];
    stalled.stallClose = true;
    if (phase === "open awaiting connected") {
      vi.advanceTimersByTime(9_000);
      stalled.open();
      stalled.deliver({ type: "ping" });
    }
    vi.advanceTimersByTime(phase === "connecting" ? 10_000 : 1_000);
    expect(onClose).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "handshake_timeout" }),
    );
    expect(stalled.readyState).toBe(2);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(3);

    const replacement = sockets[2];
    const stateListener = vi.fn();
    transport.onConnectionState(stateListener);
    stateListener.mockClear();
    stalled.open();
    stalled.deliver(connected);
    stalled.deliver({ type: "event", threadId: "thread-1", ...delta("99", "Stale") });
    stalled.stallClose = false;
    stalled.close(4403);
    expect(stateListener).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.seq)).toEqual(["1"]);

    replacement.open();
    expect(replacement.sent).toEqual([]);
    replacement.deliver(connected);
    expect(JSON.parse(replacement.sent[0])).toEqual({
      type: "resume",
      subscriptions: [{ threadId: "thread-1", lastSeq: "1" }],
    });
    replacement.deliver({
      type: "subscribed",
      threadId: "thread-1",
      catchup: [delta("1", "Early "), delta("2", "catch-up ")],
      state,
    });
    replacement.deliver({ type: "event", threadId: "thread-1", ...delta("3", "final line") });
    expect(events).toEqual([
      delta("1", "Early "),
      delta("2", "catch-up "),
      delta("3", "final line"),
    ]);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(3);
    expect(stateListener).toHaveBeenLastCalledWith({ kind: "connected" });
  } finally {
    transport.disconnect();
  }
});

it("teardown cancels the handshake and fences a late connected frame", () => {
  const { transport, sockets, onClose } = setup();
  sockets[0].stallClose = true;
  transport.disconnect();
  sockets[0].open();
  sockets[0].deliver(connected);
  vi.advanceTimersByTime(20_000);
  expect(sockets).toHaveLength(1);
  expect(sockets[0].sent).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the injected deadline and cancels it on close before a new attempt", () => {
  const { transport, sockets, onClose } = setup(100);
  try {
    vi.advanceTimersByTime(99);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    sockets[1].close(1006);
    vi.advanceTimersByTime(100);
    expect(onClose).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    sockets[2].deliver(connected);
    vi.advanceTimersByTime(100);
    expect(onClose).toHaveBeenCalledTimes(2);
  } finally {
    transport.disconnect();
  }
});

it("retires a silent connected socket without waiting for native close and resumes its reply", () => {
  const { transport, sockets, events, onClose } = setup();
  const states = vi.fn();
  transport.onConnectionState(states);
  try {
    const silent = sockets[0];
    silent.open();
    silent.deliver(connected);
    silent.deliver({ type: "subscribed", threadId: "thread-1", catchup: [], state });
    silent.deliver({ type: "event", threadId: "thread-1", ...delta("1", "Early ") });
    silent.stallClose = true;
    vi.advanceTimersByTime(44_999);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 4000, reason: "ping_timeout" }),
    );
    expect(silent.readyState).toBe(2);
    expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "reconnecting" }));

    silent.deliver({ type: "event", threadId: "thread-1", ...delta("99", "Stale") });
    expect(events).toEqual([delta("1", "Early ")]);
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
    const replacement = sockets[1];
    replacement.open();
    replacement.deliver(connected);
    expect(JSON.parse(replacement.sent[0])).toEqual({
      type: "resume",
      subscriptions: [{ threadId: "thread-1", lastSeq: "1" }],
    });
    replacement.deliver({
      type: "subscribed",
      threadId: "thread-1",
      catchup: [delta("2", "catch-up ")],
      state,
    });
    replacement.deliver({ type: "event", threadId: "thread-1", ...delta("3", "final line") });
    expect(events).toEqual([
      delta("1", "Early "),
      delta("2", "catch-up "),
      delta("3", "final line"),
    ]);
    silent.stallClose = false;
    silent.close(4403);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenLastCalledWith({ kind: "connected" });
  } finally {
    transport.disconnect();
  }
});

{
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
        catchup: [
          {
            seq: "1",
            event: { type: EventType.RAW, event: {} },
            sourceThreadId: THREAD_ID,
          },
        ],
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

  describe("ThreadSocketClient gap recovery", () => {
    it("does not resume past a head advertised without a delivered event", () => {
      const resumes: Array<{ subscriptions?: Array<{ lastSeq?: string }> }> = [];
      let socket: FakeThreadSocket | null = null;
      const transport = new ThreadSocketClient({
        url: () => "ws://test/api/threads/ws",
        toError: (error) => new Error(error.message),
        cancelTurn: vi.fn(),
        webSocketFactory: () => {
          socket = new FakeThreadSocket((_target, frame) => {
            if ((frame as { type?: string }).type === "resume") {
              resumes.push(frame as { subscriptions?: Array<{ lastSeq?: string }> });
            }
          });
          return socket;
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
        expect(harness.gapEvents).toEqual([
          expect.objectContaining({ toSeq: HEAD_SEQ.toString() }),
        ]);
        // The truncated catch-up is skipped, not replayed onto the reducer.
        expect(harness.deliveredEvents).toEqual([]);
      } finally {
        harness.unsubscribe();
        harness.transport.disconnect();
      }
    });
  });
}

{
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  function setup() {
    let callback: (hint: ConnectivityHint) => void = () => {};
    const unsubscribe = vi.fn();
    let source: object | undefined;
    const hints: ConnectivityHintsPort = {
      subscribe: (owner, listener) => {
        source = owner;
        callback = listener;
        return unsubscribe;
      },
      reportConnected: vi.fn(),
      reportDisconnected: vi.fn(),
    };
    const sockets: FakeThreadSocket[] = [];
    const transport = new ThreadSocketClient({
      url: () => "ws://test/api/threads/ws",
      toError: (error) => new Error(error.message),
      cancelTurn: vi.fn(),
      connectivity: hints,
      webSocketFactory: () => {
        const socket = new FakeThreadSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const states: ConnectionState[] = [];
    transport.onConnectionState((state) => states.push(state));
    transport.connect();
    return {
      sockets,
      source,
      states,
      hints,
      hint: (hint: ConnectivityHint) => callback(hint),
      close: () => {
        transport.disconnect();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
      },
    };
  }
  it("retry-now skips backoff only while disconnected and never after terminal", () => {
    const { sockets, states, hint, close } = setup();
    sockets[0].open();
    hint("retry-now");
    expect(sockets).toHaveLength(1);
    sockets[0].close(1006);
    expect(states.at(-1)?.kind).toBe("reconnecting");
    hint("retry-now");
    expect(sockets).toHaveLength(2);
    sockets[1].close(4403);
    expect(states.at(-1)).toMatchObject({ kind: "terminal", code: 4403 });
    hint("retry-now");
    expect(sockets).toHaveLength(2);
    close();
  });
  it("retry-now replaces a stalled connecting socket without waiting for its close handshake", () => {
    const { sockets, states, hint, close } = setup();
    sockets[0].stallClose = true;
    hint("retry-now");
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toEqual({ kind: "connecting", attempt: 1 });
    close();
  });
}

{
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
      const message = {
        ...subscribedMessage(),
        catchup,
      } as unknown as WsServerMessage;
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
}
