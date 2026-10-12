/** Production-adapter contract coverage for document transport status subscription. */

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

const { classifyDocumentTransportClose, createHocuspocusDocumentTransport } = await import(
  "./hocuspocus-document-transport"
);

describe("Hocuspocus document transport adapter", () => {
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
});
