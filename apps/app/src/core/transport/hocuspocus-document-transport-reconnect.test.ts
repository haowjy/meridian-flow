// @vitest-environment jsdom
/** Recovery hints exercise the real Hocuspocus retry loop with socket-boundary fakes. */
import { MessageType } from "@hocuspocus/provider";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ConnectivityHint, ConnectivityHintsPort } from "./connectivity-hints";

const sockets = vi.hoisted(() => [] as FakeSocket[]);
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  stallClose = false;
  binaryType = "arraybuffer";
  constructor(_url: string | URL, _protocols?: string | string[]) {
    super();
    sockets.push(this);
  }
  send() {}
  close(code = 1000, reason = "") {
    this.readyState = this.stallClose ? 2 : 3;
    if (this.stallClose) return;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
  connected() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
    // Hocuspocus resolves connection attempts on the first server frame (Ping).
    this.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array([MessageType.Ping]).buffer }),
    );
  }
}
vi.mock("./tapped-websocket", () => ({
  TappedWebSocket: FakeSocket,
  notifyYjsRoomAttached: () => {},
}));
vi.mock("./dev-transport", () => ({ buildSameOriginWsUrl: () => "wss://test/yjs" }));
const { createHocuspocusDocumentTransport } = await import("./hocuspocus-document-transport");
let cleanup: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
});
function setup() {
  let callback: (hint: ConnectivityHint) => void = () => {};
  const hints: ConnectivityHintsPort = {
    subscribe: (_source, listener) => {
      callback = listener;
      return () => {};
    },
    reportConnected: vi.fn(),
    reportDisconnected: vi.fn(),
  };
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const transport = createHocuspocusDocumentTransport({
    roomName: "document-1",
    document,
    awareness,
    connectivityHints: hints,
  });
  cleanup = () => {
    transport.destroy();
    awareness.destroy();
    document.destroy();
  };
  return { transport, hints, hint: (hint: ConnectivityHint) => callback(hint) };
}
it("cancels backoff and connects immediately without leaving a second retry loop", async () => {
  const { hint } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].close(1006);
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(1);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  sockets[1].connected();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(2);
});
it("keeps healthy sockets and closes them immediately on offline", async () => {
  const { hint, hints } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].connected();
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(1);
  expect(sockets[0].readyState).toBe(1);
  sockets[0].stallClose = true;
  hint("suspect-offline");
  expect(sockets[0].readyState).toBe(2);
  expect(hints.reportConnected).toHaveBeenCalled();
  expect(hints.reportDisconnected).toHaveBeenCalled();
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
});
it.each(["terminal", "destroyed"])("never resurrects a %s room", async (state) => {
  const { hint, transport } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].close(1006);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  if (state === "terminal") sockets[1].close(4406, "client-schema-superseded");
  else transport.destroy();
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(2);
});

it("fences the delayed close retry while a hinted replacement is still connecting", async () => {
  const { hint } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].connected();
  sockets[0].close(1006);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(2);
  expect(sockets[1].readyState).toBe(0);
});
it("fences the pre-first-message retry after a hinted replacement becomes healthy", async () => {
  const { hint } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].readyState = 1;
  sockets[0].dispatchEvent(new Event("open"));
  sockets[0].close(1006);
  await vi.advanceTimersByTimeAsync(0);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].connected();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(2);
  expect(sockets[1].readyState).toBe(1);
});
