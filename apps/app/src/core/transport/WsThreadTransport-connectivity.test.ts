// @vitest-environment jsdom
/** Server-confirmed thread connection reports recovery to peers. */
import { afterEach, expect, it, vi } from "vitest";
import { WsThreadTransport } from "@/core/transport/WsThreadTransport";

vi.mock("@/client/api/threads-api", () => ({ cancelTurn: vi.fn() }));
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  send() {}
  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
});
it("real thread connected frame reports connectivity success", () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const reportConnected = vi.fn();
  const socket = new FakeSocket();
  const transport = new WsThreadTransport({
    connectivityHints: { subscribe: () => () => {}, reportConnected, reportDisconnected: vi.fn() },
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  const states: unknown[] = [];
  transport.onConnectionState((s) => states.push(s));
  transport.connect();
  socket.readyState = 1;
  socket.dispatchEvent(new Event("open"));
  expect(reportConnected).not.toHaveBeenCalled();
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "connected",
        userId: "account",
        scope: { type: "standalone" },
        serverVersion: "1",
        connectionToken: "token",
      }),
    }),
  );

  transport.disconnect();
  vi.unstubAllGlobals();
  expect(states).toContainEqual({ kind: "connected" });
  expect(reportConnected).toHaveBeenCalledTimes(1);
});
