// @vitest-environment jsdom
/** Recovery hints exercise the real Hocuspocus retry loop with socket-boundary fakes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ConnectivityHint, ConnectivityHintsPort } from "./connectivity-hints";

import { DocumentSocketHarness, sentSyncKinds } from "./test-support/DocumentSocketHarness";

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
it.each([
  ["never opened; replacement receives first frame", "connecting", true],
  ["opened without first frame; replacement receives first frame", "open", true],
  ["received first frame; replacement remains CONNECTING", "connected", false],
] as const)("cancels the old retry: %s", async (_label, phase, replacementHealthy) => {
  const { hint } = setup();
  await vi.advanceTimersByTimeAsync(0);
  if (phase === "open") sockets[0].open();
  if (phase === "connected") sockets[0].connected();
  sockets[0].deliverClose(1006);
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(1);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  if (replacementHealthy) sockets[1].connected();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets).toHaveLength(2);
  expect(sockets[1].readyState).toBe(replacementHealthy ? 1 : 0);
});
it.each(["terminal", "destroyed"])("never resurrects a %s room", async (state) => {
  const { hint, transport } = setup();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].deliverClose(1006);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  if (state === "terminal") sockets[1].deliverClose(4406, "client-schema-superseded");
  else transport.destroy();
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(2);
});

it("clears saved before offline status and restores it after hinted reconnect acknowledgements", async () => {
  const { document, transport, hint, hints } = setup();
  let acknowledged = false;
  const events: string[] = [];
  transport.subscribeServerAcknowledgement?.((value) => {
    acknowledged = value;
    events.push(`saved:${value}`);
  });
  transport.subscribeStatus?.((state) => events.push(`${state.kind}:${acknowledged}`));
  const handshake = (socket: DocumentSocketHarness) => {
    socket.open();
    socket.syncStep1("document-1", document);
    socket.syncStep2("document-1", document, Y.encodeStateVector(document));
  };
  await vi.advanceTimersByTimeAsync(0);
  handshake(sockets[0]);
  sockets[0].acknowledge("document-1");
  expect(acknowledged).toBe(true);
  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(1);
  expect(sockets[0].readyState).toBe(1);
  expect(hints.reportConnected).toHaveBeenCalled();

  events.length = 0;
  vi.spyOn(sockets[0], "close").mockImplementation(() => sockets[0].stallClose());
  hint("suspect-offline");
  expect(events).toEqual(["saved:false", "disconnected:false"]);
  expect(sockets[0].readyState).toBe(2);
  expect(hints.reportDisconnected).toHaveBeenCalled();

  hint("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
  handshake(sockets[1]);
  expect(acknowledged).toBe(false);
  sockets[1].acknowledge("document-1");
  expect(acknowledged).toBe(true);
  document.getText("body").insert(0, "typed after reconnect");
  expect(sentSyncKinds(sockets[1])).toEqual(["step2", "update"]);
  expect(acknowledged).toBe(false);
  sockets[1].acknowledge("document-1");
  expect(acknowledged).toBe(true);
});
