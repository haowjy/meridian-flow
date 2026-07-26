/** Production-adapter contract coverage for document transport status subscription. */

import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", () => {
  const WebSocketStatus = {
    Connected: "connected",
    Connecting: "connecting",
    Disconnected: "disconnected",
  } as const;

  class HocuspocusProviderWebsocket {
    readonly status = WebSocketStatus.Disconnected;
  }

  class HocuspocusProvider {
    readonly synced = false;
    readonly unsyncedChanges = 0;

    attach(): void {}
    destroy(): void {}
  }

  return { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus };
});

vi.mock("./dev-transport", () => ({
  buildSameOriginWsUrl: () => "ws://test/api/yjs",
}));

vi.mock("./tapped-websocket", () => ({
  notifyYjsRoomAttached: () => {},
  TappedWebSocket: class {},
}));

const { createHocuspocusDocumentTransport } = await import("./hocuspocus-document-transport");

describe("Hocuspocus document transport adapter", () => {
  it("emits its initial status before subscribeStatus returns", () => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const transport = createHocuspocusDocumentTransport({
      roomName: "document-1",
      document,
      awareness,
    });
    if (!transport.subscribeStatus) throw new Error("subscribeStatus is required");

    let initialStatus: unknown;
    const unsubscribe = transport.subscribeStatus((status) => {
      initialStatus = status;
    });

    expect(initialStatus).toEqual({ kind: "disconnected" });

    unsubscribe();
    transport.destroy();
    awareness.destroy();
    document.destroy();
  });
});
