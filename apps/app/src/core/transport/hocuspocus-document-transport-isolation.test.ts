// @vitest-environment jsdom
/** Document transports keep terminal schema refusals scoped to the rejected room. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";

import type { ConnectionState } from "./ThreadTransport";

import { DocumentSocketHarness, sentSyncKinds } from "./test-support/DocumentSocketHarness";

vi.mock("./dev-transport", () => ({
  buildSameOriginWsUrl: (path: string) => `ws://test${path}`,
}));

vi.mock("./tapped-websocket", async () => {
  const { DocumentSocketHarness } = await import("./test-support/DocumentSocketHarness");
  return { notifyYjsRoomAttached: () => {}, TappedWebSocket: DocumentSocketHarness };
});

const { createHocuspocusDocumentTransport } = await import("./hocuspocus-document-transport");

beforeEach(() => {
  vi.useFakeTimers();
  DocumentSocketHarness.instances.length = 0;
});

afterEach(() => vi.useRealTimers());

describe("Hocuspocus document transport isolation", () => {
  it("does not fan out or reconnect after one room's terminal schema refusal", async () => {
    const firstDocument = createCollabYDoc();
    const secondDocument = createCollabYDoc();
    const first = createHocuspocusDocumentTransport({
      roomName: "document-1",
      document: firstDocument,
      awareness: new Awareness(firstDocument),
    });
    const second = createHocuspocusDocumentTransport({
      roomName: "document-2",
      document: secondDocument,
      awareness: new Awareness(secondDocument),
    });
    const firstStates: ConnectionState[] = [];
    const secondStates: ConnectionState[] = [];
    first.subscribeStatus?.((state) => firstStates.push(state));
    second.subscribeStatus?.((state) => secondStates.push(state));

    await vi.advanceTimersByTimeAsync(0);
    expect(DocumentSocketHarness.instances).toHaveLength(2);
    const [firstSocket, secondSocket] = DocumentSocketHarness.instances;
    if (!firstSocket || !secondSocket) throw new Error("missing room sockets");
    firstSocket.open();
    secondSocket.open();
    firstSocket.syncStep1("document-1", firstDocument);
    secondSocket.syncStep1("document-2", secondDocument);
    await vi.advanceTimersByTimeAsync(0);
    firstSocket.deliverClose(4406, "client-schema-superseded");

    expect(firstStates.at(-1)).toEqual({
      kind: "reset",
      reason: "client-schema-superseded",
      code: 4406,
    });
    expect(secondStates.at(-1)).toEqual({ kind: "connected" });
    expect(firstSocket.closeCalls).toBeGreaterThan(0);
    expect(secondSocket.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(DocumentSocketHarness.instances).toEqual([firstSocket, secondSocket]);
    expect(firstStates.at(-1)?.kind).toBe("reset");
    expect(secondStates.at(-1)).toEqual({ kind: "connected" });
    secondDocument.getText("body").insert(0, "healthy room still writes");
    expect(sentSyncKinds(secondSocket)).toEqual(["step2", "update"]);

    first.destroy();
    second.destroy();
    firstDocument.destroy();
    secondDocument.destroy();
  });
});
