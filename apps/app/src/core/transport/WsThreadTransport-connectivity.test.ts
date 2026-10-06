// @vitest-environment jsdom
/** Thread recovery and success reporting through the real transport boundary. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectivityHint, ConnectivityHintsPort } from "./connectivity-hints";
import type { ConnectionState } from "./ThreadTransport";
import { FakeThreadSocket } from "./test-support/FakeThreadSocket";
import { WsThreadTransport } from "./WsThreadTransport";
import {
  computePersistentReconnectDelayMs,
  computeReconnectDelayMs,
  DEFAULT_WS_RECONNECT,
} from "./ws-reconnect";

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
it("suspect-offline closes an open socket and publishes a retrying state", () => {
  const { sockets, source, states, hint, hints, close } = setup();
  sockets[0].open();
  sockets[0].stallClose = true;
  hint("suspect-offline");
  expect(sockets[0].readyState).toBe(2);
  expect(states.at(-1)?.kind).toBe("reconnecting");
  expect(hints.reportDisconnected).toHaveBeenCalledWith(source);
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
it("native open is not success; the real connected frame reports connectivity success", () => {
  const { sockets, states, hints, close } = setup();
  sockets[0].open();
  expect(hints.reportConnected).not.toHaveBeenCalled();
  sockets[0].deliver({
    type: "connected",
    userId: "account",
    scope: { type: "standalone" },
    serverVersion: "1",
    connectionToken: "token",
  });
  expect(states).toContainEqual({ kind: "connected" });
  expect(hints.reportConnected).toHaveBeenCalledTimes(1);
  close();
});

it("uses five aggressive retries before persistent recovery with unchanged jitter and cap", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { sockets, states, close } = setup();
  for (const [index, delay] of [250, 500, 1_000, 2_000, 4_000, 30_000].entries()) {
    sockets[index].close(1006);
    expect(states.at(-1)).toEqual({
      kind: index < 5 ? "reconnecting" : "degraded",
      attempt: index + 1,
      nextRetryAt: Date.now() + delay,
    });
    vi.advanceTimersByTime(delay);
  }
  expect(
    [0, 1].map((random) => computeReconnectDelayMs(DEFAULT_WS_RECONNECT, 10, () => random)),
  ).toEqual([4_000, 6_000]);
  expect(
    [0, 1].map((random) => computePersistentReconnectDelayMs(DEFAULT_WS_RECONNECT, () => random)),
  ).toEqual([24_000, 36_000]);
  close();
});
