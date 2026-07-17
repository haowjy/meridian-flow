/** Behavioral tests for transparent string-frame observation. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: unknown[] = [];
  readonly url: string;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }
}

describe("TappedWebSocket thread observation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observes final strings in both directions without changing delivery", async () => {
    const { setThreadWireTap, TappedWebSocket } = await import("./tapped-websocket");
    const observed: Array<[string, string, number]> = [];
    setThreadWireTap({
      onStringFrame: (direction, data, socketEpoch) =>
        observed.push([direction, data, socketEpoch]),
      onSocketOpen: vi.fn(),
      onSocketClose: vi.fn(),
    });
    const socket = new TappedWebSocket("wss://app.localhost/api/threads/ws", undefined, "thread");
    const delivered: string[] = [];
    socket.addEventListener("message", (event) => delivered.push((event as MessageEvent).data));

    socket.send('{"type":"pong"}');
    socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"ping"}' }));

    expect((socket as unknown as FakeWebSocket).sent).toEqual(['{"type":"pong"}']);
    expect(delivered).toEqual(['{"type":"ping"}']);
    expect(observed).toEqual([
      ["client_to_server", '{"type":"pong"}', 1],
      ["server_to_client", '{"type":"ping"}', 1],
    ]);
  });

  it("contains observer failures and still sends and delivers each frame", async () => {
    const { setThreadWireTap, TappedWebSocket } = await import("./tapped-websocket");
    setThreadWireTap({
      onStringFrame: () => {
        throw new Error("observer unavailable");
      },
      onSocketOpen: vi.fn(),
      onSocketClose: vi.fn(),
    });
    const socket = new TappedWebSocket("wss://app.localhost/api/threads/ws", undefined, "thread");
    const delivered = vi.fn();
    socket.addEventListener("message", delivered);

    expect(() => socket.send("outgoing")).not.toThrow();
    expect(() =>
      socket.dispatchEvent(new MessageEvent("message", { data: "incoming" })),
    ).not.toThrow();

    expect((socket as unknown as FakeWebSocket).sent).toEqual(["outgoing"]);
    expect(delivered).toHaveBeenCalledTimes(1);
  });
});
