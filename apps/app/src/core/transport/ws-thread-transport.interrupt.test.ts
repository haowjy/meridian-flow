// @vitest-environment jsdom
/**
 * WsThreadTransport interrupt-response contract:
 *  - `respondInterrupt` reports whether the frame actually left the socket so
 *    the settlement owner can tell "never sent" from "sent, awaiting response";
 *  - non-fatal interrupt rejection frames fan out to `onInterruptResponseError`
 *    and never to a subscription's fatal `onError`.
 */
import type { WsServerMessage } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { WsThreadTransport } from "./WsThreadTransport";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: WsServerMessage): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

const RESPONSE = {
  threadId: "thread-1",
  turnId: "turn-1",
  interruptId: "interrupt-1",
  value: { value: "yes" },
} as const;

function setup() {
  let socket: FakeWebSocket | undefined;
  const transport = new WsThreadTransport({
    pingTimeoutMs: 60_000,
    webSocketFactory: (url) => {
      socket = new FakeWebSocket(url);
      return socket as unknown as WebSocket;
    },
  });
  return {
    transport,
    socket: () => socket as FakeWebSocket,
  };
}

describe("WsThreadTransport.respondInterrupt", () => {
  it("reports false when there is no open socket", () => {
    const { transport } = setup();
    expect(transport.respondInterrupt(RESPONSE)).toBe(false);
  });

  it("reports true and writes the frame once the socket is open", () => {
    const { transport, socket } = setup();
    transport.connect();
    expect(transport.respondInterrupt(RESPONSE)).toBe(false);

    socket().open();
    expect(transport.respondInterrupt(RESPONSE)).toBe(true);
    expect(JSON.parse(socket().sent.at(-1) ?? "{}")).toEqual({
      type: "interrupt.respond",
      ...RESPONSE,
    });
    transport.disconnect();
  });
});

describe("WsThreadTransport interrupt response errors", () => {
  it("fans non-fatal interrupt rejections out to the settlement listener, not fatal onError", () => {
    const { transport, socket } = setup();
    const onInterruptResponseError = vi.fn();
    const unsubscribe = transport.onInterruptResponseError(onInterruptResponseError);
    const onError = vi.fn();
    transport.subscribe("thread-1", { onEvent: vi.fn(), onError });
    transport.connect();
    socket().open();

    socket().receive({
      type: "error",
      kind: "error",
      error: {
        code: "interrupt_not_pending",
        message: "No pending interrupt",
        retryable: false,
        source: "system",
      },
      threadId: "thread-1",
    });

    expect(onInterruptResponseError).toHaveBeenCalledTimes(1);
    expect(onInterruptResponseError.mock.calls[0]?.[0]).toMatchObject({ threadId: "thread-1" });
    expect(onError).not.toHaveBeenCalled();

    unsubscribe();
    transport.disconnect();
  });
});
