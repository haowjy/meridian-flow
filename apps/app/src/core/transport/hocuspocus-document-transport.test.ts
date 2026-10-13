/** Production-adapter contract coverage for document transport status subscription. */

import { MessageType } from "@hocuspocus/provider";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import * as encoding from "lib0/encoding";
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
    ).toEqual({ kind: "reset", reason: "branch-stale-doc", disposition: "rebuild", code: 4205 });
    expect(
      classifyDocumentTransportClose("document-1", {
        code: 1006,
        reason: "",
      }),
    ).toBeNull();
  });

  it.each([
    {
      signal: "close",
      contract: WS_CLOSE.BRANCH_GENERATION_STALE,
      pending: true,
      disposition: "superseded",
    },
    {
      signal: "denial",
      contract: WS_CLOSE.BRANCH_GENERATION_STALE,
      pending: true,
      disposition: "superseded",
    },
    { signal: "close", contract: WS_CLOSE.BRANCH_STALE, pending: true, disposition: "rebuild" },
    { signal: "native", contract: WS_CLOSE.ACCESS_CHANGED, pending: true, disposition: "refused" },
    { signal: "native", contract: WS_CLOSE.ACCESS_CHANGED, pending: false, disposition: null },
  ] as const)("classifies $signal $contract.reason with pending=$pending", async ({
    signal,
    contract,
    pending,
    disposition,
  }) => {
    const roomName = "branch:draft-1:gen:1";
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const transport = createHocuspocusDocumentTransport({ roomName, document, awareness });
    const states: DocumentSessionConnectionState[] = [];
    const access: string[] = [];
    transport.subscribeStatus?.((state) => states.push(state));
    transport.subscribeAccess?.((scope) => access.push(scope));
    try {
      await vi.advanceTimersByTimeAsync(0);
      const socket = DocumentSocketHarness.instances.at(-1);
      if (!socket) throw new Error("missing document socket");
      socket.open();
      socket.syncStep1(roomName, document);
      socket.acknowledge(roomName);
      if (pending) document.getText("body").insert(0, "writer");
      const carry = transport.unacknowledgedUpdates();
      if (signal === "denial") {
        socket.receive(roomName, MessageType.Auth, (encoder) => {
          encoding.writeVarUint(encoder, 1);
          encoding.writeVarString(encoder, contract.reason);
        });
      } else if (signal === "native") {
        socket.deliverClose(contract.code, contract.reason);
      } else {
        socket.receive(roomName, MessageType.CLOSE, (encoder) =>
          encoding.writeVarString(encoder, contract.reason),
        );
      }
      if (disposition) {
        expect(states.at(-1)).toEqual({
          kind: "reset",
          reason: contract.reason,
          disposition,
          code: signal === "denial" ? undefined : signal === "native" ? contract.code : 1000,
        });
        document.getText("body").insert(0, "after reset");
        expect(transport.unacknowledgedUpdates()).toEqual(carry);
      } else {
        expect(states.at(-1)?.kind).not.toBe("reset");
        expect(access.at(-1)).toBe("read");
        expect(transport.unacknowledgedUpdates()).toBeNull();
      }
    } finally {
      transport.destroy();
      awareness.destroy();
      document.destroy();
    }
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
      socket.deliverClose(code, reason);

      expect(states.at(-1)).toEqual({ kind: "reset", reason, disposition: "schema", code });
      expect(socket.closeCalls).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(DocumentSocketHarness.instances).toEqual([socket]);
      expect(states.at(-1)).toEqual({ kind: "reset", reason, disposition: "schema", code });
    } finally {
      unsubscribe?.();
      transport.destroy();
      awareness.destroy();
      document.destroy();
    }
  });
});
