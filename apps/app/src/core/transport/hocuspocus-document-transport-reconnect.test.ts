// @vitest-environment jsdom
/** Recovery hints exercise the real Hocuspocus retry loop with socket-boundary fakes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ConnectivityHint, ConnectivityHintsPort } from "./connectivity-hints";

import { DocumentSocketHarness } from "./test-support/DocumentSocketHarness";

const sockets = DocumentSocketHarness.instances;
vi.mock("./tapped-websocket", async () => {
  const { DocumentSocketHarness } = await import("./test-support/DocumentSocketHarness");
  return { TappedWebSocket: DocumentSocketHarness, notifyYjsRoomAttached: () => {} };
});
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
  return { document, transport, hints, hint: (hint: ConnectivityHint) => callback(hint) };
}
it("cancels the old retry when the replacement receives its first frame", async () => {
  const { hint } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].deliverClose(1006);
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(1);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  sockets[1].connected();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(2);
  expect(sockets[1].readyState).toBe(1);
});
it("never resurrects a terminal room", async () => {
  const { hint } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].deliverClose(1006);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  sockets[1].deliverClose(4406, "client-schema-superseded");
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(2);
});
