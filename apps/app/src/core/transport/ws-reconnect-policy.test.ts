/** Default thread reconnect phases and jitter remain stable without configuration. */
import { afterEach, expect, it, vi } from "vitest";
import { SocketLifecycleController } from "./socket-lifecycle";
import { FakeThreadSocket } from "./test-support/FakeThreadSocket";
import {
  computePersistentReconnectDelayMs,
  computeReconnectDelayMs,
  DEFAULT_WS_RECONNECT,
} from "./ws-reconnect";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("uses five aggressive retries before persistent recovery with unchanged jitter and cap", () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let socket!: FakeThreadSocket;
  const controller = new SocketLifecycleController(
    {
      buildUrl: () => "wss://test/threads",
      wantsConnection: () => true,
      onOpen: () => {},
      onMessage: () => {},
      publishConnectionState: () => {},
    },
    {
      webSocketFactory: () => {
        socket = new FakeThreadSocket();
        return socket as unknown as WebSocket;
      },
    },
  );
  controller.ensureConnected();
  for (const [index, delay] of [250, 500, 1_000, 2_000, 4_000, 30_000].entries()) {
    socket.dispatchEvent(
      Object.assign(new Event("close"), { code: 1006, reason: "", wasClean: false }),
    );
    expect(controller.state).toEqual({
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
  controller.teardown();
});
