/** Behavioral tests for thread observation at the socket lifecycle boundary. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireDirection } from "./wire-tap";

type Observed =
  | [kind: "open", epoch: number]
  | [direction: WireDirection, data: string, epoch: number]
  | [kind: "close", epoch: number, code: number, wasClean: boolean];

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: unknown[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  finishClose(code = 1000, wasClean = true): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close") as Event & { code: number; reason: string; wasClean: boolean };
    event.code = code;
    event.reason = "raw close reason";
    event.wasClean = wasClean;
    this.dispatchEvent(event);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe("SocketLifecycleController thread observation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observes lifecycle and final strings without changing delivery", async () => {
    const { setThreadWireTap } = await import("./wire-tap");
    const { SocketLifecycleController } = await import("./socket-lifecycle");
    const observed: Observed[] = [];
    let wantsConnection = true;
    const received: unknown[] = [];
    setThreadWireTap({
      onSocketOpen: (epoch) => observed.push(["open", epoch]),
      onStringFrame: (direction, data, epoch) => observed.push([direction, data, epoch]),
      onSocketClose: (epoch, code, wasClean) => observed.push(["close", epoch, code, wasClean]),
    });
    const controller = new SocketLifecycleController({
      buildUrl: () => "wss://app.localhost/api/threads/ws",
      wantsConnection: () => wantsConnection,
      onOpen: vi.fn(),
      onMessage: (data) => received.push(data),
      publishConnectionState: vi.fn(),
    });

    controller.ensureConnected();
    const socket = controller.currentSocket as unknown as FakeWebSocket;
    socket.open();
    controller.send('{"type":"pong"}');
    socket.receive('{"type":"ping"}');
    socket.receive(new Uint8Array([1, 2, 3]));
    wantsConnection = false;
    socket.finishClose(1000, true);

    expect(socket.sent).toEqual(['{"type":"pong"}']);
    expect(received).toEqual(['{"type":"ping"}', new Uint8Array([1, 2, 3])]);
    expect(observed).toEqual([
      ["open", 1],
      ["client_to_server", '{"type":"pong"}', 1],
      ["server_to_client", '{"type":"ping"}', 1],
      ["close", 1, 1000, true],
    ]);
  });

  it("contains observer failures and still drives the transport", async () => {
    const { setThreadWireTap } = await import("./wire-tap");
    const { SocketLifecycleController } = await import("./socket-lifecycle");
    const fail = () => {
      throw new Error("observer unavailable");
    };
    setThreadWireTap({
      onSocketOpen: fail,
      onStringFrame: fail,
      onSocketClose: fail,
    });
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const controller = new SocketLifecycleController({
      buildUrl: () => "wss://app.localhost/api/threads/ws",
      wantsConnection: () => false,
      onOpen,
      onMessage,
      onClose,
      publishConnectionState: vi.fn(),
    });

    controller.ensureConnected();
    const socket = controller.currentSocket as unknown as FakeWebSocket;
    expect(() => socket.open()).not.toThrow();
    expect(() => controller.send("outgoing")).not.toThrow();
    expect(() => socket.receive("incoming")).not.toThrow();
    expect(() => socket.finishClose()).not.toThrow();

    expect(socket.sent).toEqual(["outgoing"]);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith("incoming");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
