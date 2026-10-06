/** Production-adapter contract coverage for document transport status subscription. */

import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { DocumentSessionConnectionState } from "@/core/editor/document-session";

import { DocumentSocketHarness } from "./test-support/DocumentSocketHarness";

vi.mock("./dev-transport", () => ({
  buildSameOriginWsUrl: (path: string) => `ws://test${path}`,
}));

vi.mock("./tapped-websocket", async () => {
  const { DocumentSocketHarness } = await import("./test-support/DocumentSocketHarness");
  return { notifyYjsRoomAttached: () => {}, TappedWebSocket: DocumentSocketHarness };
});

beforeEach(() => {
  vi.useFakeTimers();
  DocumentSocketHarness.instances.length = 0;
});
afterEach(() => vi.useRealTimers());

const { CollabSchemaWebSocket, classifyDocumentTransportClose, createHocuspocusDocumentTransport } =
  await import("./hocuspocus-document-transport");

describe("Hocuspocus document transport adapter", () => {
  it.each([
    [4406, "client-schema-superseded"],
    [4407, "document-schema-stale"],
  ] as const)("classifies schema refusal %i as a typed reset", (code, reason) => {
    expect(classifyDocumentTransportClose("document-1", { code, reason: "untrusted" })).toEqual({
      kind: "reset",
      reason,
      code,
    });
  });

  it("leaves existing terminal and branch close classifications unchanged", () => {
    expect(
      classifyDocumentTransportClose("document-1", {
        code: 4403,
        reason: "permission-denied",
      }),
    ).toEqual({ kind: "unauthorized", reason: "permission-denied", code: 4403 });
    expect(
      classifyDocumentTransportClose("branch:draft-1:gen:1", {
        code: 4205,
        reason: "branch-stale-doc",
      }),
    ).toEqual({ kind: "reset", reason: "branch-stale-doc", code: 4205 });
    expect(
      classifyDocumentTransportClose("document-1", {
        code: 1006,
        reason: "",
      }),
    ).toBeNull();
  });

  it("offers exactly the formatted schema subprotocol", () => {
    new CollabSchemaWebSocket("ws://test/ws/yjs");

    expect(DocumentSocketHarness.instances.at(-1)).toMatchObject({
      url: "ws://test/ws/yjs",
      protocols: [formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)],
    });
  });

  it("uses the unversioned Yjs path and injects the schema socket", async () => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const transport = createHocuspocusDocumentTransport({
      roomName: "document-1",
      document,
      awareness,
    });

    await vi.advanceTimersByTimeAsync(0);
    const socket = DocumentSocketHarness.instances.at(-1);
    expect(socket).toBeInstanceOf(CollabSchemaWebSocket);
    expect(socket).toMatchObject({
      url: "ws://test/ws/yjs",
      protocols: [formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)],
    });

    transport.destroy();
    awareness.destroy();
    document.destroy();
  });

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

    expect(initialStatus).toEqual({ kind: "connecting", attempt: 1 });

    unsubscribe();
    transport.destroy();
    awareness.destroy();
    document.destroy();
  });

  it.each([
    [4406, "client-schema-superseded"],
    [4407, "document-schema-stale"],
  ] as const)("delivers native schema refusal %i through the real provider", async (code, reason) => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const transport = createHocuspocusDocumentTransport({
      roomName: "document-1",
      document,
      awareness,
    });
    const states: DocumentSessionConnectionState[] = [];
    const unsubscribe = transport.subscribeStatus?.((state) => states.push(state));

    try {
      await vi.advanceTimersByTimeAsync(0);
      const socket = DocumentSocketHarness.instances.at(-1);
      if (!socket) throw new Error("missing schema socket");
      socket.open();
      socket.syncStep1("document-1", document);
      await vi.advanceTimersByTimeAsync(0);
      socket.deliverClose(code, "untrusted");

      expect(states.at(-1)).toEqual({ kind: "reset", reason, code });
      expect(socket.closeCalls).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(DocumentSocketHarness.instances).toEqual([socket]);
      expect(states.at(-1)).toEqual({ kind: "reset", reason, code });
    } finally {
      unsubscribe?.();
      transport.destroy();
      awareness.destroy();
      document.destroy();
    }
  });

  it("publishes real-provider status transitions and stops delivery after unsubscribe", async () => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const transport = createHocuspocusDocumentTransport({
      roomName: "document-1",
      document,
      awareness,
    });
    if (!transport.subscribeStatus) throw new Error("subscribeStatus is required");
    const states: DocumentSessionConnectionState[] = [];
    const unsubscribe = transport.subscribeStatus((state) => states.push(state));

    try {
      expect(states).toEqual([{ kind: "connecting", attempt: 1 }]);
      await vi.advanceTimersByTimeAsync(0);
      const socket = DocumentSocketHarness.instances.at(-1);
      if (!socket) throw new Error("missing status socket");
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toEqual({ kind: "connected" });
      expect(transport.synced).toBe(false);

      socket.syncStep1("document-1", document);
      expect(states.at(-1)).toEqual({ kind: "connected" });
      expect(transport.synced).toBe(false);
      socket.syncStep2("document-1", document, Y.encodeStateVector(document));
      await transport.whenSynced;
      expect(transport.synced).toBe(true);

      unsubscribe();
      const beforeClose = [...states];
      socket.deliverClose();
      expect(states).toEqual(beforeClose);
      let currentStatus: unknown;
      const unsubscribeCurrent = transport.subscribeStatus((state) => {
        currentStatus = state;
      });
      expect(currentStatus).toEqual({ kind: "disconnected" });
      unsubscribeCurrent();
    } finally {
      unsubscribe();
      transport.destroy();
      awareness.destroy();
      document.destroy();
    }
  });
});
