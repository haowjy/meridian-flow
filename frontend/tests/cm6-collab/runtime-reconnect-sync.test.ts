import { describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { CollabSyncRuntime } from "@/core/cm6-collab";

const TEST_DOC_ID = "00000000-0000-0000-0000-000000000001";
const DOC_WS_PREFIX_SYNC = 0x00;

describe("CollabSyncRuntime reconnect sync", () => {
  // [unit-tester:dispose] verification -- safe to delete after passing
  it("responds with SyncStep2 when reused runtime receives server SyncStep1", () => {
    const sentFrames: Uint8Array[] = [];
    const runtime = new CollabSyncRuntime({
      documentId: TEST_DOC_ID,
      sendBinary: (frame) => sentFrames.push(frame),
    });

    runtime.startSync();

    const firstOutbound = sentFrames[0] ?? new Uint8Array();
    expect(firstOutbound[0]).toBe(DOC_WS_PREFIX_SYNC);
    expect(readSyncType(firstOutbound.subarray(1))).toBe(0);

    const serverDoc = new Y.Doc();
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, serverDoc);

    runtime.handleBinaryFrame(
      withPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder)),
    );

    expect(sentFrames).toHaveLength(2);
    const secondOutbound = sentFrames[1] ?? new Uint8Array();
    expect(secondOutbound[0]).toBe(DOC_WS_PREFIX_SYNC);
    expect(readSyncType(secondOutbound.subarray(1))).toBe(1);
    expect(runtime.getStatus()).toBe("connected");

    runtime.destroy();
    serverDoc.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("uses raw transport prefix bytes for sync and awareness frames", () => {
    const sentFrames: Uint8Array[] = [];
    const runtime = new CollabSyncRuntime({
      documentId: TEST_DOC_ID,
      sendBinary: (frame) => sentFrames.push(frame),
    });

    runtime.startSync();
    runtime.setLocalAwarenessState({ name: "Meridian" });

    expect(sentFrames[0]?.[0]).toBe(DOC_WS_PREFIX_SYNC);
    expect(sentFrames[1]?.[0]).toBe(0x01);

    runtime.destroy();
  });
});

function withPrefix(prefix: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = prefix;
  framed.set(payload, 1);
  return framed;
}

function readSyncType(syncPayload: Uint8Array): number {
  const decoder = decoding.createDecoder(syncPayload);
  return decoding.readVarUint(decoder);
}
