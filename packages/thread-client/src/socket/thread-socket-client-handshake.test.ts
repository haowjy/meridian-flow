/** Thread socket deadlines preserve delivered cursors through restart recovery. */
import { EventType, type SequencedEvent } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
