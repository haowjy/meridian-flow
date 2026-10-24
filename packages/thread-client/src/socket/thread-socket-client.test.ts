/** Thread recovery and success reporting through the real transport boundary.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Thread-scoped retry and observer-isolated transport
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeThreadSocket } from "../test-support/fake-thread-socket";
import type { ConnectivityHint, ConnectivityHintsPort } from "./socket-ports";
import { ThreadSocketClient } from "./thread-socket-client";
import type { ConnectionState } from "./thread-transport";

beforeEach(() => {
  vi.useFakeTimers();
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
  const transport = new ThreadSocketClient({
    url: () => "ws://test/api/threads/ws",
    toError: (error) => new Error(error.message),
    cancelTurn: vi.fn(),
    connectivity: hints,
    webSocketFactory: () => {
      const socket = new FakeThreadSocket();
      sockets.push(socket);
      return socket;
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
