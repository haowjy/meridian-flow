// @vitest-environment jsdom
/** Document transports keep terminal schema refusals scoped to the rejected room. */
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import type { ConnectionState } from "./ThreadTransport";

const hocuspocus = vi.hoisted(() => ({
  providers: [] as Array<{
    websocketProvider: FakeWebsocket;
    onClose: (input: { event: { code: number; reason: string } }) => void;
  }>,
  websockets: [] as FakeWebsocket[],
}));

type FakeWebsocket = {
  status: "disconnected";
  providers: typeof hocuspocus.providers;
  destroyed: boolean;
  emitClose(event: { code: number; reason: string }): void;
  destroy(): void;
};

vi.mock("@hocuspocus/provider", () => {
  class HocuspocusProviderWebsocket implements FakeWebsocket {
    status = "disconnected" as const;
    providers: typeof hocuspocus.providers = [];
    destroyed = false;

    constructor() {
      hocuspocus.websockets.push(this);
    }

    emitClose(event: { code: number; reason: string }) {
      for (const provider of this.providers) provider.onClose({ event });
    }

    destroy() {
      this.destroyed = true;
    }
  }

  class HocuspocusProvider {
    synced = false;
    unsyncedChanges = 0;
    private readonly configuration: (typeof hocuspocus.providers)[number];

    constructor(configuration: (typeof hocuspocus.providers)[number]) {
      this.configuration = configuration;
      configuration.websocketProvider.providers.push(configuration);
      hocuspocus.providers.push(configuration);
    }

    attach() {}

    destroy() {
      const providers = this.configuration.websocketProvider.providers;
      const index = providers.indexOf(this.configuration);
      if (index >= 0) providers.splice(index, 1);
    }
  }

  return {
    HocuspocusProvider,
    HocuspocusProviderWebsocket,
    WebSocketStatus: {
      Connected: "connected",
      Connecting: "connecting",
      Disconnected: "disconnected",
    },
  };
});

const { createHocuspocusDocumentTransport } = await import("./hocuspocus-document-transport");

beforeEach(() => {
  hocuspocus.providers.length = 0;
  hocuspocus.websockets.length = 0;
});

describe("Hocuspocus document transport isolation", () => {
  it("does not fan one room's schema refusal into sibling document sessions", () => {
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

    expect(hocuspocus.websockets).toHaveLength(2);
    hocuspocus.websockets[0]?.emitClose({ code: 4406, reason: "client-schema-superseded" });

    expect(firstStates.at(-1)).toEqual({
      kind: "reset",
      reason: "client-schema-superseded",
      code: 4406,
    });
    expect(secondStates.at(-1)).toEqual({ kind: "disconnected" });
    expect(hocuspocus.websockets[0]?.destroyed).toBe(true);
    expect(hocuspocus.websockets[1]?.destroyed).toBe(false);

    first.destroy();
    second.destroy();
    firstDocument.destroy();
    secondDocument.destroy();
  });
});
