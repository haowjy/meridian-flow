import { EventType, encodeWsServerMessage } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/client/api/threads-api", () => ({
  cancelTurn: vi.fn(),
}));

import { cancelTurn } from "@/client/api/threads-api";
import { WsThreadTransport } from "./WsThreadTransport";

type ListenerMap = {
  // biome-ignore lint/suspicious/noExplicitAny: test harness event handlers
  [K in "open" | "message" | "error" | "close"]: Array<(event: any) => void>;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly listeners: ListenerMap = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  // biome-ignore lint/suspicious/noExplicitAny: test harness
  addEventListener(type: keyof ListenerMap, listener: (event: any) => void): void {
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "normal" });
  }

  // biome-ignore lint/suspicious/noExplicitAny: test harness
  emit(type: keyof ListenerMap, event: any): void {
    for (const listener of this.listeners[type]) {
      listener(event);
    }
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  emitMessage(data: string): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error", {});
  }

  emitClose(code = 1006, reason = "abnormal"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  /** Simulate server proactively confirming the upgraded socket. */
  emitConnected(connectionToken = "conn-test"): void {
    this.emitMessage(
      encodeWsServerMessage({
        type: "connected",
        userId: "test-user",
        scope: { type: "standalone" },
        serverVersion: "0.0.0",
        connectionToken,
      }),
    );
  }

  /** Open + server connected frame in one call. */
  emitOpenAndConnected(): void {
    this.emitOpen();
    this.emitConnected();
  }
}

function sentFrames(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function subscribeFramesOnly(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return sentFrames(socket).filter((f) => f.type === "subscribe");
}

function resumeFramesOnly(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return sentFrames(socket).filter((f) => f.type === "resume");
}

describe("WsThreadTransport", () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          protocol: "https:",
          host: "app.meridian.localhost",
          hostname: "app.meridian.localhost",
          port: "",
        },
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeWebSocket,
      configurable: true,
    });
    vi.mocked(cancelTurn).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "WebSocket", {
      value: originalWebSocket,
      configurable: true,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses safe default timer wrappers so native timers are called with global receiver", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(function (
      this: unknown,
    ) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return 123 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(function (
      this: unknown,
    ) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
    });

    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "1" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpen();

    expect(() => socket.emitClose(1006, "network down")).not.toThrow();
    expect(setTimeoutSpy).toHaveBeenCalled();

    transport.disconnect();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("keeps a single socket alive across multiple subscriptions and only unsubscribes on the last local handler", () => {
    const transport = new WsThreadTransport();

    const onEventA = vi.fn();
    const onEventB = vi.fn();
    const onEventC = vi.fn();

    const unsubscribeA = transport.subscribe("thread_1", { onEvent: onEventA }, { after: "2" });
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    expect(socket.url).toBe("wss://app.meridian.localhost/api/threads/ws");

    socket.emitOpenAndConnected();
    expect(resumeFramesOnly(socket)).toMatchObject([
      {
        type: "resume",
        subscriptions: [{ threadId: "thread_1", lastSeq: "2" }],
      },
    ]);
    socket.emitMessage(
      encodeWsServerMessage({
        type: "subscribed",
        threadId: "thread_1",
        catchup: [],
        state: {
          threadId: "thread_1",
          status: "idle",
          runningTurnId: null,
          currentAgent: null,
          nextSeq: "2",
          resumeAfterSeq: "2",
        },
        nextSeq: "3",
      }),
    );

    const unsubscribeB = transport.subscribe("thread_1", { onEvent: onEventB }, { after: "2" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(subscribeFramesOnly(socket)).toHaveLength(0);

    const unsubscribeC = transport.subscribe("thread_2", { onEvent: onEventC }, { after: "7" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(subscribeFramesOnly(socket)).toMatchObject([
      { type: "subscribe", threadId: "thread_2", lastSeq: "7" },
    ]);

    unsubscribeA();
    expect(sentFrames(socket).filter((frame) => frame.type === "unsubscribe")).toHaveLength(0);

    unsubscribeB();
    expect(sentFrames(socket).filter((frame) => frame.type === "unsubscribe")).toMatchObject([
      { type: "unsubscribe", threadId: "thread_1" },
    ]);

    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    unsubscribeC();
  });

  it("keeps same-origin websocket URL for ts.net hosts", () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          protocol: "https:",
          host: "pop-os.tail852a76.ts.net:8445",
          hostname: "pop-os.tail852a76.ts.net",
          port: "8445",
        },
      },
      configurable: true,
    });

    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "1" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    expect(socket.url).toBe("wss://pop-os.tail852a76.ts.net:8445/api/threads/ws");
  });

  it("uses same-origin websocket URL for bare ts.net funnel host", () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          protocol: "https:",
          host: "pop-os.tail852a76.ts.net",
          hostname: "pop-os.tail852a76.ts.net",
          port: "",
        },
      },
      configurable: true,
    });

    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "1" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    expect(socket.url).toBe("wss://pop-os.tail852a76.ts.net/api/threads/ws");
  });

  it("keeps same-origin websocket URL for non-ts hosts", () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          protocol: "https:",
          host: "app.meridian.localhost:8443",
          hostname: "app.meridian.localhost",
          port: "8443",
        },
      },
      configurable: true,
    });

    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "1" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    expect(socket.url).toBe("wss://app.meridian.localhost:8443/api/threads/ws");
  });

  it("reconnects after close and resumes all active threads with latest seq", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));

    const stateSpy = vi.fn();
    const transport = new WsThreadTransport({
      backoff: {
        maxReconnectAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
      random: () => 0.5,
      now: () => Date.now(),
    });

    transport.subscribe(
      "thread_1",
      {
        onEvent: vi.fn(),
        onConnectionState: stateSpy,
      },
      { after: "4" },
    );
    transport.subscribe(
      "thread_2",
      {
        onEvent: vi.fn(),
      },
      { after: "9" },
    );

    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    first.emitOpenAndConnected();

    first.emitMessage(
      encodeWsServerMessage({
        type: "event",
        threadId: "thread_1",
        seq: "6",
        event: {
          type: EventType.RUN_STARTED,
          threadId: "thread_1",
          runId: "turn_1",
        },
      }),
    );

    first.emitClose(1000, "normal");

    const reconnectingState = stateSpy.mock.calls
      .map((call) => call[0])
      .find((state) => state?.kind === "reconnecting");
    expect(reconnectingState).toMatchObject({
      kind: "reconnecting",
      attempt: 1,
      nextRetryAt: Date.now() + 100,
    });

    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1] as FakeWebSocket;
    second.emitOpenAndConnected();

    const states = stateSpy.mock.calls.map((call) => call[0]);
    const connectedState = [...states].reverse().find((state) => state?.kind === "connected");
    expect(connectedState).toEqual({ kind: "connected" });

    expect(resumeFramesOnly(second)).toMatchObject([
      {
        type: "resume",
        subscriptions: [
          { threadId: "thread_1", lastSeq: "6" },
          { threadId: "thread_2", lastSeq: "9" },
        ],
      },
    ]);
  });

  it("enters degraded state and surfaces an error after reconnect budget is exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));

    const stateSpy = vi.fn();
    const onError = vi.fn();
    const transport = new WsThreadTransport({
      backoff: {
        maxReconnectAttempts: 1,
        baseDelayMs: 100,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
      random: () => 0.5,
      now: () => Date.now(),
    });

    transport.subscribe("thread_1", {
      onEvent: vi.fn(),
      onConnectionState: stateSpy,
      onError,
    });

    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    first.emitOpenAndConnected();
    first.emitClose(1006, "network down");

    expect(stateSpy.mock.calls.map((call) => call[0])).toContainEqual(
      expect.objectContaining({ kind: "reconnecting", attempt: 1 }),
    );
    expect(onError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    const second = FakeWebSocket.instances[1] as FakeWebSocket;
    second.emitClose(1006, "still down");

    expect(stateSpy.mock.calls.map((call) => call[0])).toContainEqual(
      expect.objectContaining({ kind: "degraded", attempt: 2 }),
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rewinds lastSeq and resubscribes when a later run passes an older stream cursor", () => {
    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "5" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpenAndConnected();
    socket.emitMessage(
      encodeWsServerMessage({
        type: "event",
        threadId: "thread_1",
        seq: "8",
        event: {
          type: EventType.RUN_STARTED,
          threadId: "thread_1",
          runId: "turn_1",
        },
      }),
    );

    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "3" });

    expect(subscribeFramesOnly(socket)).toContainEqual({
      type: "subscribe",
      threadId: "thread_1",
      lastSeq: "3",
    });
  });

  it("dedupes by seq and dispatches gap payloads", () => {
    const onEvent = vi.fn();
    const onGap = vi.fn();

    const transport = new WsThreadTransport();
    transport.subscribe(
      "thread_1",
      {
        onEvent,
        onGap,
      },
      { after: "1" },
    );

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpenAndConnected();

    // subscribed with catchup
    socket.emitMessage(
      encodeWsServerMessage({
        type: "subscribed",
        threadId: "thread_1",
        catchup: [
          {
            seq: "2",
            event: {
              type: EventType.RUN_STARTED,
              threadId: "thread_1",
              runId: "turn_1",
            },
          },
        ],
        state: {
          threadId: "thread_1",
          status: "active",
          runningTurnId: "turn_1",
          currentAgent: null,
          nextSeq: "3",
          resumeAfterSeq: "1",
        },
        nextSeq: "3",
      }),
    );

    // duplicate seq=2 should be deduped
    socket.emitMessage(
      encodeWsServerMessage({
        type: "event",
        threadId: "thread_1",
        seq: "2",
        event: {
          type: EventType.RUN_FINISHED,
          threadId: "thread_1",
          runId: "turn_1",
        },
      }),
    );

    // gap
    socket.emitMessage(
      encodeWsServerMessage({
        type: "gap",
        threadId: "thread_1",
        cause: "replay_limit_exceeded",
        fromSeq: "3",
        toSeq: "10",
      }),
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        seq: "2",
        sourceThreadId: "thread_1",
      }),
    );
    expect(onGap).toHaveBeenCalledWith({
      threadId: "thread_1",
      cause: "replay_limit_exceeded",
      fromSeq: "3",
      toSeq: "10",
      message: undefined,
      gapCount: 1,
    });
  });

  it("preserves sourceThreadId from server frames for family-stream safety", () => {
    const onEvent = vi.fn();
    const transport = new WsThreadTransport();
    transport.subscribe(
      "thread_root",
      {
        onEvent,
      },
      { after: "0" },
    );

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpenAndConnected();
    socket.emitMessage(
      encodeWsServerMessage({
        type: "event",
        threadId: "thread_root",
        sourceThreadId: "thread_child",
        seq: "1",
        event: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg_1",
          delta: "child output",
        },
      }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        seq: "1",
        sourceThreadId: "thread_child",
      }),
    );
  });

  it("responds to server ping with pong", () => {
    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "0" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpenAndConnected();

    socket.emitMessage(encodeWsServerMessage({ type: "ping", ts: 1234567890 }));

    const pongFrames = sentFrames(socket).filter((f) => f.type === "pong");
    expect(pongFrames).toHaveLength(1);
  });

  it("sends checkpoint responses over the open thread websocket", () => {
    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "0" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpenAndConnected();

    transport.respondCheckpoint({
      threadId: "thread_1",
      turnId: "turn_1",
      checkpointId: "checkpoint_1",
      value: { value: "approved" },
    });

    expect(sentFrames(socket).filter((frame) => frame.type === "checkpoint.respond")).toEqual([
      {
        type: "checkpoint.respond",
        threadId: "thread_1",
        turnId: "turn_1",
        checkpointId: "checkpoint_1",
        value: { value: "approved" },
      },
    ]);
  });

  it("keeps subscriptions alive for late checkpoint-response errors", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent, onError }, { after: "0" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpenAndConnected();

    socket.emitMessage(
      encodeWsServerMessage({
        type: "error",
        kind: "error",
        error: {
          code: "checkpoint_not_pending",
          message: "Checkpoint is no longer pending",
          retryable: false,
          source: "system",
        },
        threadId: "thread_1",
      }),
    );
    socket.emitMessage(
      encodeWsServerMessage({
        type: "event",
        threadId: "thread_1",
        seq: "1",
        event: {
          type: EventType.RUN_FINISHED,
          threadId: "thread_1",
          runId: "turn_1",
        },
      }),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        seq: "1",
        sourceThreadId: "thread_1",
      }),
    );
  });

  it("delegates cancel requests to the threads API helper", async () => {
    vi.mocked(cancelTurn).mockResolvedValue({
      threadId: "thread_1",
      turnId: "turn_1",
      status: "cancelled",
    });

    const transport = new WsThreadTransport();
    await transport.cancel("thread_1", "turn_1");

    expect(cancelTurn).toHaveBeenCalledWith({
      data: { threadId: "thread_1", turnId: "turn_1" },
    });
  });

  it("captures connectionToken from the server connected frame", () => {
    const transport = new WsThreadTransport();
    transport.subscribe("thread_1", { onEvent: vi.fn() }, { after: "0" });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socket.emitOpen();
    expect(transport.getConnectionToken()).toBeUndefined();

    socket.emitConnected("conn-owner-abc");
    expect(transport.getConnectionToken()).toBe("conn-owner-abc");

    socket.emitClose(1006, "network down");
    expect(transport.getConnectionToken()).toBeUndefined();
  });
});
