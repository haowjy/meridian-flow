/** Thread socket deadlines preserve delivered cursors through restart recovery. */
import { EventType, type SequencedEvent } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeThreadSocket as FakeSocket } from "../test-support/fake-thread-socket";
import { FakeThreadSocket } from "../test-support/fake-thread-socket";
import { ThreadSocketClient } from "./thread-socket-client";

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
    // A handler added while the resume replay is in flight, with a cursor at the replay's own,
    // gets the catch-up before the live frame that arrives ahead of it.
    const joinedLate: SequencedEvent[] = [];
    transport.subscribe("thread-1", { onEvent: (event) => joinedLate.push(event) }, { after: "1" });
    replacement.deliver({ type: "event", threadId: "thread-1", ...delta("3", "final line") });
    expect(joinedLate).toEqual([]);
    replacement.deliver({
      type: "subscribed",
      threadId: "thread-1",
      catchup: [delta("2", "catch-up ")],
      state,
    });
    expect(joinedLate).toEqual([delta("2", "catch-up "), delta("3", "final line")]);
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

const internalError = {
  code: "internal",
  message: "Internal server error",
  retryable: false,
  source: "system" as const,
};

// A reconnect that has sent its `resume` for `thread-1`, with handlers A (at 1) and B (joined at
// 1 meanwhile) waiting on it.
function resumeInFlight() {
  const { transport, sockets, events } = setup();
  const first = sockets[0];
  first.open();
  first.deliver(connected);
  first.deliver({ type: "subscribed", threadId: "thread-1", catchup: [delta("1", "a")], state });
  first.close(1006);
  vi.advanceTimersByTime(250);
  const next = sockets[1];
  next.open();
  next.deliver(connected);
  const joined: SequencedEvent[] = [];
  transport.subscribe("thread-1", { onEvent: (event) => joined.push(event) }, { after: "1" });
  return { transport, sockets, events, joined, next };
}

function recoversOn(next: FakeSocket, sockets: FakeSocket[]) {
  expect(sockets).toHaveLength(2);
  vi.advanceTimersByTime(500);
  expect(sockets).toHaveLength(3);
  const again = sockets[2];
  again.open();
  again.deliver(connected);
  expect(JSON.parse(again.sent[0])).toEqual({
    type: "resume",
    subscriptions: [{ threadId: "thread-1", lastSeq: "1" }],
  });
  expect(next.readyState).toBeGreaterThan(1);
  return again;
}

it("an unscoped server error while a replay waits drops the connection, and both handlers resume once", () => {
  const { transport, sockets, events, joined, next } = resumeInFlight();
  try {
    next.deliver({ type: "event", threadId: "thread-1", ...delta("3", "live") });
    next.deliver({
      type: "error",
      kind: "error",
      error: internalError,
    });
    const again = recoversOn(next, sockets);
    again.deliver({
      type: "subscribed",
      threadId: "thread-1",
      catchup: [delta("2", "b"), delta("3", "live")],
      state,
    });
    again.deliver({ type: "event", threadId: "thread-1", ...delta("4", "c") });
    expect(events.map((event) => event.seq)).toEqual(["1", "2", "3", "4"]);
    expect(joined.map((event) => event.seq)).toEqual(["2", "3", "4"]);
  } finally {
    transport.disconnect();
  }
});

it("a thread-scoped error for a waiting replay recovers the same way", () => {
  const { transport, sockets, events, next } = resumeInFlight();
  try {
    next.deliver({
      type: "error",
      kind: "error",
      threadId: "thread-1",
      error: internalError,
    });
    const again = recoversOn(next, sockets);
    again.deliver({ type: "subscribed", threadId: "thread-1", catchup: [delta("2", "b")], state });
    expect(events.map((event) => event.seq)).toEqual(["1", "2"]);
  } finally {
    transport.disconnect();
  }
});

it("a replay that never settles ends at the deadline, whatever the pings", () => {
  const { transport, sockets, events, joined, next } = resumeInFlight();
  try {
    next.deliver({ type: "event", threadId: "thread-1", ...delta("3", "live") });
    for (let elapsed = 0; elapsed < 15_000; elapsed += 5_000) {
      vi.advanceTimersByTime(5_000);
      next.deliver({ type: "ping" });
    }
    vi.advanceTimersByTime(4_999);
    expect(sockets).toHaveLength(2);
    expect(joined).toEqual([]);
    vi.advanceTimersByTime(1);
    const again = recoversOn(next, sockets);
    again.deliver({
      type: "subscribed",
      threadId: "thread-1",
      catchup: [delta("2", "b"), delta("3", "live")],
      state,
    });
    expect(events.map((event) => event.seq)).toEqual(["1", "2", "3"]);
    expect(joined.map((event) => event.seq)).toEqual(["2", "3"]);
  } finally {
    transport.disconnect();
  }
});

it("a handler below the in-flight request gets its own replay (the lower-cursor join)", () => {
  const sockets: FakeThreadSocket[] = [];
  const transport = new ThreadSocketClient({
    url: () => "ws://test/api/threads/ws",
    toError: (error) => new Error(error.message),
    cancelTurn: vi.fn(),
    webSocketFactory: () => {
      const socket = new FakeThreadSocket();
      sockets.push(socket);
      return socket;
    },
  });
  try {
    const b: string[] = [];
    const c: string[] = [];
    const leaveA = transport.subscribe("thread-1", { onEvent: () => {} }, { after: "100" });
    const first = sockets[0];
    first.open();
    first.deliver(connected);
    first.deliver({ type: "subscribed", threadId: "thread-1", catchup: [], state });
    transport.subscribe("thread-1", { onEvent: (e) => b.push(e.seq) }, { after: "300" });
    leaveA();
    first.close(1006);
    vi.advanceTimersByTime(250);
    const next = sockets[1];
    next.open();
    next.deliver(connected);
    expect(JSON.parse(next.sent[0])).toMatchObject({
      type: "resume",
      subscriptions: [{ lastSeq: "300" }],
    });
    transport.subscribe("thread-1", { onEvent: (e) => c.push(e.seq) }, { after: "200" });
    next.deliver({ type: "subscribed", threadId: "thread-1", catchup: [delta("350", "x")], state });
    expect(JSON.parse(next.sent[1])).toMatchObject({ type: "subscribe", lastSeq: "200" });
    next.deliver({
      type: "subscribed",
      threadId: "thread-1",
      catchup: [delta("250", "y"), delta("350", "x")],
      state,
    });
    next.deliver({ type: "event", threadId: "thread-1", ...delta("400", "z") });
    expect(c).toEqual(["250", "350", "400"]);
    expect(b).toEqual(["350", "400"]);
  } finally {
    transport.disconnect();
  }
});

it("a cursorless handler joining a replay gets the catch-up, then live frames, in order", () => {
  const { transport, next } = resumeInFlight();
  try {
    const late: string[] = [];
    transport.subscribe("thread-1", { onEvent: (e) => late.push(e.seq) });
    next.deliver({ type: "event", threadId: "thread-1", ...delta("3", "live") });
    expect(late).toEqual([]);
    next.deliver({ type: "subscribed", threadId: "thread-1", catchup: [delta("2", "b")], state });
    next.deliver({ type: "event", threadId: "thread-1", ...delta("4", "c") });
    expect(late).toEqual(["2", "3", "4"]);
    expect(next.sent).toHaveLength(1);
  } finally {
    transport.disconnect();
  }
});
