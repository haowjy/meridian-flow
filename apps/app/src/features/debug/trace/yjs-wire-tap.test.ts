/** Contract tests for metadata-only Yjs wire EventRecord mapping. */

import type { EventRecord } from "@meridian/contracts/observability";
import { inspectFrame } from "@meridian/yjs-inspect";
import * as encoding from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createYjsWireTap } from "./yjs-wire-tap";

function syncUpdateFrame(roomName: string, update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, roomName);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function unknownFrame(roomName: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, roomName);
  encoding.writeVarUint(encoder, 99);
  return encoding.toUint8Array(encoder);
}

function insertUpdate(): Uint8Array {
  const document = new Y.Doc();
  document.getText("manuscript").insert(0, "content-never-egresses-through-the-tap");
  return Y.encodeStateAsUpdate(document);
}

describe("createYjsWireTap", () => {
  it("maps an attached live-room update without changing the inspection payload", () => {
    const records: EventRecord[] = [];
    const tap = createYjsWireTap((record) => records.push(record), vi.fn());
    const bytes = syncUpdateFrame("document-1", insertUpdate());
    const inspection = inspectFrame(bytes);

    tap.onRoomAttached("document-1", 777);
    tap.onSocketOpen(4, "wss://app.localhost/ws/yjs");
    tap.onFrame("client_to_server", bytes, 4);

    expect(records[1]).toMatchObject({
      level: "trace",
      source: "wire.yjs",
      name: "frame",
      sensitivity: "safe",
      correlation: {
        documentId: "document-1",
        yjsClient: 777,
        yjsSpans: inspection.update?.spansKey,
      },
      stream: {
        streamId: "yjs:live:document-1",
        transport: "yjs",
        direction: "client_to_server",
        observedAt: "client",
        messageClass: "sync.update",
        bytes: bytes.byteLength,
        observerSeq: 2,
      },
      payload: { socketEpoch: 4, ...inspection },
    });
    expect(records[1]?.payload).toEqual({ socketEpoch: 4, ...inspection });
    expect(JSON.stringify(records[1])).not.toContain("content-never-egresses-through-the-tap");
  });

  it("maps branch identity and infers the sole struct client on incoming updates", () => {
    const records: EventRecord[] = [];
    const tap = createYjsWireTap((record) => records.push(record), vi.fn());
    const bytes = syncUpdateFrame("branch:draft-2:gen:3", insertUpdate());
    const inspection = inspectFrame(bytes);
    const structClient = inspection.update?.structSpans[0]?.client;

    tap.onFrame("server_to_client", bytes, 1);

    expect(records[0]).toMatchObject({
      correlation: {
        branchId: "draft-2",
        branchGeneration: 3,
        yjsClient: structClient,
        yjsSpans: inspection.update?.spansKey,
      },
      stream: {
        streamId: "yjs:branch:draft-2:gen:3",
        observerSeq: 1,
      },
    });
  });

  it("never infers an outgoing client when the room attachment is unknown", () => {
    const records: EventRecord[] = [];
    const tap = createYjsWireTap((record) => records.push(record), vi.fn());
    const bytes = syncUpdateFrame("document-1", insertUpdate());

    tap.onFrame("client_to_server", bytes, 1);

    expect(records[0]?.correlation?.yjsSpans).toBeDefined();
    expect(records[0]?.correlation?.yjsClient).toBeUndefined();
  });

  it("uses the socket fallback for unknown frames and keeps sequence across reconnects", () => {
    const records: EventRecord[] = [];
    const tap = createYjsWireTap((record) => records.push(record), vi.fn());

    tap.onSocketOpen(1, "wss://one");
    tap.onSocketClose(1, 4000, "probe", true);
    tap.onSocketOpen(2, "wss://two");
    tap.onFrame("server_to_client", unknownFrame("branch:invalid:gen:0"), 2);

    expect(records.map((record) => record.stream?.observerSeq)).toEqual([1, 2, 3, 4]);
    expect(records[1]).toMatchObject({
      level: "debug",
      name: "socket.close",
      payload: { socketEpoch: 1, code: 4000, reason: "probe", wasClean: true },
    });
    expect(records[3]).toMatchObject({
      name: "frame",
      stream: {
        streamId: "yjs:socket",
        messageClass: "unknown",
      },
      payload: {
        socketEpoch: 2,
        frame: { documentName: "branch:invalid:gen:0", messageClass: "unknown" },
      },
    });
    expect(records[3]?.correlation).toBeUndefined();
  });

  it("routes sink failures to onError and never propagates either callback", () => {
    const onError = vi.fn(() => {
      throw new Error("error counter unavailable");
    });
    const tap = createYjsWireTap(() => {
      throw new Error("sink unavailable");
    }, onError);

    expect(() => tap.onFrame("client_to_server", unknownFrame("document-1"), 1)).not.toThrow();
    expect(() => tap.onSocketOpen(1, "wss://one")).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
