/** A diagnostic observer cannot interrupt send, receive, deadlines, or reconnect. */

import { afterEach, expect, it, vi } from "vitest";
import { FakeThreadSocket } from "../test-support/fake-thread-socket";
import { SocketLifecycleController } from "./socket-lifecycle";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("contains a throwing observer while transport delivers frames and reconnects", () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);

  const sockets: FakeThreadSocket[] = [];
  const messages: unknown[] = [];
  const states: string[] = [];
  const failures: Array<{ failure: { cause: { code: string } } }> = [];
  const controller = new SocketLifecycleController(
    {
      buildUrl: () => "ws://test/threads",
      wantsConnection: () => true,
      onMessage: (data) => messages.push(data),
      publishConnectionState: (state) => states.push(state.kind),
    },
    {
      webSocketFactory: () => {
        const socket = new FakeThreadSocket();
        sockets.push(socket);
        return socket;
      },
      observer: {
        onStringFrame: () => {
          throw new Error("observer frame failure");
        },
        onSocketOpen: () => {
          throw new Error("observer open failure");
        },
        onSocketClose: () => {
          throw new Error("observer close failure");
        },
      },
      failureLog: {
        record: (record) => failures.push(record as (typeof failures)[number]),
      },
    },
  );

  controller.ensureConnected();
  const first = sockets[0];
  if (!first) throw new Error("Expected the first socket");
  first.open();
  controller.markConnected();
  expect(controller.send("client frame")).toBe(true);
  first.deliver({ type: "message" });
  expect(messages).toHaveLength(1);
  expect(states).toContain("connected");

  first.close(1006);
  expect(states.at(-1)).toBe("reconnecting");
  vi.advanceTimersByTime(250);
  expect(sockets).toHaveLength(2);
  expect(failures.map(({ failure }) => failure.cause.code)).toEqual([
    "observer_failed",
    "observer_failed",
    "observer_failed",
    "observer_failed",
  ]);

  controller.teardown();
});
