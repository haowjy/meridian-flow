import { describe, expect, it } from "vitest";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  CollabSyncRuntime,
  frameEnvelope,
  MeridianEnvelopeType,
  unwrapEnvelope,
} from "@/core/cm6-collab";

const TEST_DOC_ID = "00000000-0000-0000-0000-000000000001";

describe("CollabSyncRuntime reconnect sync", () => {
  it("responds with SyncStep2 when reused runtime receives server SyncStep1", () => {
    const sentFrames: Uint8Array[] = [];
    const runtime = new CollabSyncRuntime({
      documentId: TEST_DOC_ID,
      sendBinary: (frame) => sentFrames.push(frame),
    });

    runtime.startSync();

    const firstOutbound = unwrapEnvelope(sentFrames[0] ?? new Uint8Array());
    expect(firstOutbound.envelope).toBe(MeridianEnvelopeType.SyncStep1);

    const serverDoc = new Y.Doc();
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, serverDoc);

    runtime.handleBinaryFrame(
      frameEnvelope(
        MeridianEnvelopeType.SyncStep1,
        TEST_DOC_ID,
        encoding.toUint8Array(encoder),
      ),
    );

    expect(sentFrames).toHaveLength(2);
    const secondOutbound = unwrapEnvelope(sentFrames[1] ?? new Uint8Array());
    expect(secondOutbound.envelope).toBe(MeridianEnvelopeType.SyncStep2);
    expect(runtime.getStatus()).toBe("connected");

    runtime.destroy();
    serverDoc.destroy();
  });
});
