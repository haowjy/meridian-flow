// @vitest-environment jsdom
/** Thread recovery and success reporting through the real transport boundary. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectivityHint, ConnectivityHintsPort } from "./connectivity-hints";
import type { ConnectionState } from "./ThreadTransport";
import { FakeThreadSocket } from "./test-support/FakeThreadSocket";
import { WsThreadTransport } from "./WsThreadTransport";

vi.mock("@/client/api/threads-api", () => ({ cancelTurn: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeThreadSocket);
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
  const transport = new WsThreadTransport({
    connectivityHints: hints,
    webSocketFactory: () => {
      const socket = new FakeThreadSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
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
