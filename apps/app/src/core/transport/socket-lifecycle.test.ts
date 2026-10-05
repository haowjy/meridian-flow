/** Connectivity hints respect thread socket ownership and terminal closes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectivityHint, ConnectivityHintsPort } from "./connectivity-hints";
import { SocketLifecycleController } from "./socket-lifecycle";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  stallClose = false;
  close(code = 1000) {
    this.readyState = this.stallClose ? 2 : 3;
    if (this.stallClose) return;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "", wasClean: true }));
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  let callback: (hint: ConnectivityHint) => void = () => {};
  const unsubscribe = vi.fn();
  const hints: ConnectivityHintsPort = {
    subscribe: (_source, listener) => {
      callback = listener;
      return unsubscribe;
    },
    reportConnected: vi.fn(),
    reportDisconnected: vi.fn(),
  };
  const sockets: FakeSocket[] = [];
  const controller = new SocketLifecycleController(
    {
      buildUrl: () => "wss://test/threads",
      wantsConnection: () => true,
      onOpen: () => controller.publishConnectionState({ kind: "connected" }),
      onMessage: () => {},
      publishConnectionState: () => {},
    },
    {
      connectivityHints: hints,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
  );
  controller.ensureConnected();
  return {
    controller,
    sockets,
    hints,
    unsubscribe,
    hint: (hint: ConnectivityHint) => callback(hint),
  };
}
it("retry-now skips backoff only while disconnected and never after terminal", () => {
  const { controller, sockets, hint, hints, unsubscribe } = setup();
  sockets[0].readyState = 1;
  sockets[0].dispatchEvent(new Event("open"));
  hint("retry-now");
  expect(sockets).toHaveLength(1);
  sockets[0].close(1006);
  hint("retry-now");
  expect(sockets).toHaveLength(2);
  expect(hints.reportConnected).toHaveBeenCalledWith(controller);
  sockets[1].close(4403);
  expect(controller.state.kind).toBe("terminal");
  hint("retry-now");
  expect(sockets).toHaveLength(2);
  controller.teardown();
  expect(unsubscribe).toHaveBeenCalled();
});
it("suspect-offline closes an open socket and publishes a retrying state", () => {
  const { controller, sockets, hint, hints } = setup();
  sockets[0].readyState = 1;
  sockets[0].dispatchEvent(new Event("open"));
  sockets[0].stallClose = true;
  hint("suspect-offline");
  expect(sockets[0].readyState).toBe(2);
  expect(controller.state.kind).toBe("reconnecting");
  expect(hints.reportDisconnected).toHaveBeenCalledWith(controller);
  controller.teardown();
});

it("retry-now replaces a stalled connecting socket without waiting for its close handshake", () => {
  const { controller, sockets, hint } = setup();
  sockets[0].stallClose = true;
  hint("retry-now");
  expect(sockets).toHaveLength(2);
  expect(controller.state).toEqual({ kind: "connecting", attempt: 1 });
  controller.teardown();
});
