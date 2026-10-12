// @vitest-environment jsdom
/** Browser composition of the shared thread socket's platform ports. */
import type { ThreadSocketClientOptions } from "@meridian/thread-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { ConnectivityHints } from "@/core/transport/connectivity-hints";
import {
  notifyThreadFrame,
  notifyThreadSocketClose,
  notifyThreadSocketOpen,
} from "@/core/transport/wire-tap";
import { TransportProvider } from "./TransportProvider";

const harness = vi.hoisted(() => ({
  debug: false,
  options: null as ThreadSocketClientOptions | null,
  hints: null as ConnectivityHints | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  cancelTurn: vi.fn(),
}));
vi.mock("@meridian/thread-client", () => ({
  ThreadSocketClient: class {
    constructor(options: ThreadSocketClientOptions) {
      harness.options = options;
    }
    connect = harness.connect;
    disconnect = harness.disconnect;
  },
}));
vi.mock("@/core/debug-gate", () => ({
  get DEBUG_FEATURE_ALLOWED() {
    return harness.debug;
  },
}));
vi.mock("./ConnectivityProvider", () => ({ useConnectivityHints: () => harness.hints }));
vi.mock("@/client/api/threads-api", () => ({ cancelTurn: harness.cancelTurn }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([false, true])("injects browser ports with debug capture enabled=%s", async (debug) => {
  harness.debug = debug;
  harness.hints = new ConnectivityHints({ browser: window, document, random: Math.random });
  const WebSocketFactory = vi.fn(class {});
  vi.stubGlobal("WebSocket", WebSocketFactory);
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<TransportProvider>child</TransportProvider>));
    const options = harness.options;
    expect(options).not.toBeNull();
    if (!options) throw new Error("Provider did not compose a socket client");
    const expectedUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/threads/ws`;
    expect(options.url()).toBe(expectedUrl);
    expect(options.webSocketFactory(options.url())).toBeInstanceOf(WebSocketFactory);
    expect(WebSocketFactory).toHaveBeenCalledWith(expectedUrl);
    expect(options.connectivity).toBe(harness.hints);
    expect(options.observer).toEqual(
      debug
        ? {
            onStringFrame: notifyThreadFrame,
            onSocketOpen: notifyThreadSocketOpen,
            onSocketClose: notifyThreadSocketClose,
          }
        : undefined,
    );
    const error = options.toError({
      code: "internal",
      message: "Protocol error",
      source: "system",
      retryable: false,
    });
    expect(error).toBeInstanceOf(MeridianApiError);
    expect((error as MeridianApiError).code).toBe("internal");
    await options.cancelTurn("thread-1", "turn-1");
    expect(harness.cancelTurn).toHaveBeenCalledWith({
      data: { threadId: "thread-1", turnId: "turn-1" },
    });
    expect(harness.connect).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
  expect(harness.disconnect).toHaveBeenCalledWith("app_unmount");
});
