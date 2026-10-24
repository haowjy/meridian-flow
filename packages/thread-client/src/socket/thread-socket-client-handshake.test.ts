/** Thread socket deadlines preserve delivered cursors through restart recovery. */
import { EventType, type SequencedEvent, type WsServerMessage } from "@meridian/contracts/protocol";
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
/** The `subscribe` requests a socket was sent, in order. */
function requests(
  socket: FakeThreadSocket,
): Array<{ requestId: string; threadId: string; lastSeq?: string }> {
  return socket.sent.map((data) => JSON.parse(data)).filter((frame) => frame.type === "subscribe");
}
function subscribed(socket: FakeThreadSocket, catchup: unknown[] = [], after = "0", index = -1) {
  const request = requests(socket).at(index);
  socket.deliver({
    type: "subscribed",
    requestId: request?.requestId,
    threadId: request?.threadId,
    after,
    catchup,
    state,
  });
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
    subscribed(sockets[0]);
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
    expect(requests(replacement)).toEqual([
      { type: "subscribe", requestId: expect.any(String), threadId: "thread-1", lastSeq: "1" },
    ]);
    subscribed(replacement, [delta("1", "Early "), delta("2", "catch-up ")], "1");
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
    subscribed(silent);
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
    expect(requests(replacement)).toEqual([
      { type: "subscribe", requestId: expect.any(String), threadId: "thread-1", lastSeq: "1" },
    ]);
    subscribed(replacement, [delta("2", "catch-up ")], "1");
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

// Replay requests: each `subscribe` has an id, and each ends in an outcome the client attributes to it.
function replayHarness() {
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
  transport.connect();
  sockets[0].open();
  sockets[0].deliver(connected);
  const socket = () => sockets.at(-1) as FakeThreadSocket;
  const asks = (threadId: string) => requests(socket()).filter((r) => r.threadId === threadId);
  const frame = (seq: string) => delta(seq, `d${seq}`);
  return {
    sockets,
    transport,
    socket,
    asks,
    unsubscribes: () =>
      socket()
        .sent.map((data) => JSON.parse(data))
        .filter((message) => message.type === "unsubscribe"),
    join(threadId: string, after?: string) {
      const seqs: string[] = [];
      const errors: Error[] = [];
      const leave = transport.subscribe(
        threadId,
        { onEvent: (event) => seqs.push(event.seq), onError: (error) => errors.push(error) },
        after === undefined ? undefined : { after },
      );
      return { seqs, errors, leave };
    },
    live: (threadId: string, seq: string) =>
      socket().deliver({ type: "event", threadId, ...frame(seq) }),
    answer(threadId: string, after: string, catchup: string[], index = -1) {
      const request = asks(threadId).at(index);
      socket().deliver({
        type: "subscribed",
        requestId: request?.requestId,
        threadId,
        after,
        catchup: catchup.map(frame),
        state,
      });
    },
    fail(threadId: string, retryable: boolean, index = -1) {
      socket().deliver({
        type: "error",
        kind: "error",
        requestId: asks(threadId).at(index)?.requestId,
        threadId,
        error: { code: "internal", message: "read failed", retryable, source: "system" },
      });
    },
  };
}

type Replay = ReturnType<typeof replayHarness>;

it.each<{
  row: string;
  run: (h: Replay) => { a: string[]; b: string[]; c?: string[]; asks: Array<string | undefined> };
  expected: { a: string[]; b: string[]; c?: string[]; asks: Array<string | undefined> };
}>([
  {
    row: "in flight, cursor at or above the request's: waits, sends nothing",
    run(h) {
      const a = h.join("thread-1", "100");
      const b = h.join("thread-1", "150");
      h.live("thread-1", "300");
      h.answer("thread-1", "100", ["200"]);
      return { a: a.seqs, b: b.seqs, asks: h.asks("thread-1").map((r) => r.lastSeq) };
    },
    expected: { a: ["200", "300"], b: ["200", "300"], asks: ["100"] },
  },
  {
    row: "in flight, cursor below the request's: supersedes with one request from it",
    run(h) {
      const a = h.join("thread-1", "100");
      const b = h.join("thread-1", "50");
      h.live("thread-1", "300");
      h.answer("thread-1", "50", ["75", "120"]);
      return { a: a.seqs, b: b.seqs, asks: h.asks("thread-1").map((r) => r.lastSeq) };
    },
    expected: { a: ["120", "300"], b: ["75", "120", "300"], asks: ["100", "50"] },
  },
  {
    row: "lease active, cursor at or above the position: live from now",
    run(h) {
      const a = h.join("thread-1", "100");
      h.answer("thread-1", "100", []);
      const b = h.join("thread-1", "100");
      h.live("thread-1", "200");
      return { a: a.seqs, b: b.seqs, asks: h.asks("thread-1").map((r) => r.lastSeq) };
    },
    expected: { a: ["200"], b: ["200"], asks: ["100"] },
  },
  {
    row: "lease active, cursor below an empty settle's floor: re-requests (the lease floor is the position)",
    run(h) {
      const a = h.join("thread-1", "300");
      h.answer("thread-1", "300", []);
      const b = h.join("thread-1", "200");
      h.answer("thread-1", "200", ["250", "350"]);
      return { a: a.seqs, b: b.seqs, asks: h.asks("thread-1").map((r) => r.lastSeq) };
    },
    expected: { a: ["350"], b: ["250", "350"], asks: ["300", "200"] },
  },
  {
    row: "in flight, no cursor: takes the position and the catch-up above it before any live frame",
    run(h) {
      const a = h.join("thread-1", "100");
      h.answer("thread-1", "100", ["150"]);
      const b = h.join("thread-1", "50");
      const c = h.join("thread-1");
      h.live("thread-1", "200");
      h.answer("thread-1", "50", ["75", "150", "200"]);
      return { a: a.seqs, b: b.seqs, c: c.seqs, asks: h.asks("thread-1").map((r) => r.lastSeq) };
    },
    expected: {
      a: ["150", "200"],
      b: ["75", "150", "200"],
      c: ["200"],
      asks: ["100", "50"],
    },
  },
  {
    row: "first subscriber, no cursor: asks without lastSeq",
    run(h) {
      const a = h.join("thread-1");
      h.answer("thread-1", "0", ["1"]);
      return { a: a.seqs, b: [], asks: h.asks("thread-1").map((r) => r.lastSeq) };
    },
    expected: { a: ["1"], b: [], asks: [undefined] },
  },
])("join: $row", ({ run, expected }) => {
  const h = replayHarness();
  try {
    const result = run(h);
    expect(result).toEqual(expected);
  } finally {
    h.transport.disconnect();
  }
});

it("applies a superseded request's acknowledgement as frames, so no handler misses one", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "100");
    h.answer("thread-1", "100", []);
    const b = h.join("thread-1", "50");
    const c = h.join("thread-1", "25");
    // r2's `subscribed` arrives after r3 was sent: the socket's order puts it before r2's live frames.
    h.answer("thread-1", "50", ["75", "150"], -2);
    h.live("thread-1", "200");
    h.answer("thread-1", "25", ["40", "75", "150"]);
    expect(a.seqs).toEqual(["150", "200"]);
    expect(b.seqs).toEqual(["75", "150", "200"]);
    expect(c.seqs).toEqual(["40", "75", "150", "200"]);
  } finally {
    h.transport.disconnect();
  }
});

it("fails one thread's request alone: its lease voids, it retries at its own backoff, the others stream on", () => {
  const h = replayHarness();
  try {
    const a1 = h.join("thread-1", "100");
    h.answer("thread-1", "100", []);
    const b1 = h.join("thread-2", "10");
    const a2 = h.join("thread-1", "50");
    h.fail("thread-1", true);

    // Both of thread-1's handlers hear it once; thread-2 still awaits its own replay.
    expect(a1.errors).toHaveLength(1);
    expect(a2.errors).toHaveLength(1);
    expect(b1.errors).toHaveLength(0);
    h.live("thread-2", "20");
    expect(b1.seqs).toEqual([]);
    expect(h.sockets).toHaveLength(1);

    for (const delay of [250, 500, 1_000]) {
      const before = h.asks("thread-1").length;
      vi.advanceTimersByTime(delay - 1);
      expect(h.asks("thread-1")).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(h.asks("thread-1")).toHaveLength(before + 1);
      expect(h.asks("thread-1").at(-1)?.lastSeq).toBe("50");
      if (delay < 1_000) h.fail("thread-1", true);
      if (delay === 250) {
        // A sibling acknowledgement and an unrelated catalog failure must not reset this retry.
        h.transport.subscribeCatalog("project-1", () => {});
        const catalog = h
          .socket()
          .sent.map((data) => JSON.parse(data))
          .at(-1);
        h.socket().deliver({
          type: "error",
          kind: "error",
          requestId: catalog.requestId,
          error: {
            code: "not_found",
            message: "Project not found",
            retryable: false,
            source: "system",
          },
        });
        h.answer("thread-2", "10", []);
        h.live("thread-2", "30");
        expect(b1.seqs).toEqual(["20", "30"]);
        expect(b1.errors).toHaveLength(0);
        expect(h.sockets).toHaveLength(1);
      }
    }
    expect(a1.errors).toHaveLength(1);
    expect(h.asks("thread-2")).toHaveLength(1);

    h.answer("thread-1", "50", ["60", "110"]);
    expect(a1.seqs).toEqual(["110"]);
    expect(a2.seqs).toEqual(["60", "110"]);
  } finally {
    h.transport.disconnect();
  }
});

it("refuses a thread on a non-retryable error: unsubscribes, stays quiet, and a join asks again", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "0");
    h.fail("thread-1", false);
    expect(a.errors).toHaveLength(1);
    expect(h.unsubscribes()).toEqual([
      { type: "unsubscribe", requestId: expect.any(String), threadId: "thread-1" },
    ]);
    vi.advanceTimersByTime(30_000);
    expect(h.asks("thread-1")).toHaveLength(1);

    h.join("thread-1", "0");
    expect(h.asks("thread-1")).toHaveLength(2);
  } finally {
    h.transport.disconnect();
  }
});

it("ends an unanswered request at its deadline, whatever pings arrive, and retries it", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "0");
    vi.advanceTimersByTime(15_000);
    h.socket().deliver({ type: "ping", ts: 1 });
    vi.advanceTimersByTime(4_999);
    expect(a.errors).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(a.errors).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(h.asks("thread-1")).toHaveLength(2);
  } finally {
    h.transport.disconnect();
  }
});

it("lets an error that names no request end nothing", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "0");
    h.socket().deliver({
      type: "error",
      kind: "error",
      threadId: "thread-1",
      error: { code: "internal", message: "stray", retryable: true, source: "system" },
    });
    expect(a.errors).toHaveLength(1);
    h.answer("thread-1", "0", ["1"]);
    expect(a.seqs).toEqual(["1"]);
    expect(h.asks("thread-1")).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(a.errors).toHaveLength(1);
  } finally {
    h.transport.disconnect();
  }
});

it("removing the last waiter unsubscribes and leaves no timer to fire", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "0");
    a.leave();
    expect(h.unsubscribes()).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(h.asks("thread-1")).toHaveLength(1);
    expect(a.errors).toHaveLength(0);

    const b = h.join("thread-1", "0");
    h.fail("thread-1", true);
    b.leave();
    vi.advanceTimersByTime(30_000);
    expect(h.asks("thread-1")).toHaveLength(2);

    for (const outcome of ["error", "gap"] as const) {
      let leave = () => {};
      const onGap = vi.fn(() => leave());
      leave = h.transport.subscribe(
        "thread-1",
        {
          onEvent: () => {},
          onError: () => leave(),
          onGap,
        },
        { after: "0" },
      );
      if (outcome === "error") h.fail("thread-1", true);
      else
        h.socket().deliver({
          type: "gap",
          threadId: "thread-1",
          requestId: h.asks("thread-1").at(-1)?.requestId as string,
          cause: "replay_limit_exceeded",
          fromSeq: "0",
          toSeq: "100",
        } satisfies Extract<WsServerMessage, { type: "gap" }>);
      if (outcome === "gap") expect(onGap).toHaveBeenCalledOnce();
      expect(JSON.parse(h.socket().sent.at(-1) as string).type).toBe("unsubscribe");
      const replacement = h.join("thread-1", "100");
      h.answer("thread-1", "100", ["150"]);
      const before = h.asks("thread-1").length;
      vi.advanceTimersByTime(250);
      expect(h.asks("thread-1")).toHaveLength(before);
      h.live("thread-1", "200");
      expect(replacement.seqs).toEqual(["150", "200"]);
      replacement.leave();
    }
  } finally {
    h.transport.disconnect();
  }
});

it("keeps the other handler waiting when the one that asked for history leaves a pending retry", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "100");
    h.answer("thread-1", "100", []);
    const b = h.join("thread-1", "50");
    h.fail("thread-1", true);
    b.leave();
    h.live("thread-1", "130");
    expect(a.seqs).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(h.asks("thread-1").at(-1)?.lastSeq).toBe("100");
    h.answer("thread-1", "100", ["120", "130"]);
    expect(a.seqs).toEqual(["120", "130"]);
  } finally {
    h.transport.disconnect();
  }
});

it("reconnects with one subscribe per thread, and each handler gets its frames once", () => {
  const h = replayHarness();
  try {
    const a = h.join("thread-1", "0");
    const b = h.join("thread-2", "0");
    h.answer("thread-1", "0", ["1"]);
    h.answer("thread-2", "0", ["1"]);
    h.sockets[0].close(1006);
    vi.advanceTimersByTime(250);
    h.sockets[1].open();
    h.sockets[1].deliver(connected);
    expect(h.sockets[1].sent.map((data) => JSON.parse(data).type)).toEqual([
      "subscribe",
      "subscribe",
    ]);
    h.answer("thread-1", "1", ["1", "2"]);
    h.answer("thread-2", "1", ["1", "2"]);
    h.live("thread-1", "3");
    expect(a.seqs).toEqual(["1", "2", "3"]);
    expect(b.seqs).toEqual(["1", "2"]);
  } finally {
    h.transport.disconnect();
  }
});

it("reports the close of a CLOSING socket replaced before its close event", () => {
  const sockets: FakeThreadSocket[] = [];
  const closedGenerations: number[] = [];
  let handlerCloses = 0;
  const client = new ThreadSocketClient({
    url: () => "ws://test",
    webSocketFactory: () => {
      const socket = new FakeThreadSocket();
      sockets.push(socket);
      return socket;
    },
    toError: (error) => new Error(error.message),
    cancelTurn: async () => ({}) as never,
  });
  client.onSocketGenerationClosed((generation) => closedGenerations.push(generation));
  try {
    client.subscribe(
      "thread-1",
      { onEvent: () => {}, onClose: () => handlerCloses++ },
      { after: "0" },
    );
    sockets[0].open();
    sockets[0].deliver(connected);
    sockets[0].stallClose = true;
    sockets[0].close(1006);
    client.subscribe("thread-2", { onEvent: () => {} }, { after: "0" });
    sockets[0].stallClose = false;
    sockets[0].close(1006);
    expect(sockets).toHaveLength(2);
    expect(handlerCloses).toBe(1);
    expect(closedGenerations).toEqual([1]);
    expect(sockets[1].readyState).toBe(0);
  } finally {
    client.disconnect();
  }
});
