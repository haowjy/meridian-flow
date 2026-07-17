import { describe, expect, it } from "vitest";

import { createDurableSyncBarrier, parseSafetyNotice } from "./hocuspocus-document-transport";

describe("Hocuspocus durable sync barrier", () => {
  it("does not settle on initial SyncStep2 while updates remain unacknowledged", async () => {
    const barrier = createDurableSyncBarrier();
    let settled = false;
    void barrier.promise.then(() => {
      settled = true;
    });

    barrier.noteUnsyncedChanges(0);
    barrier.markInitialSyncComplete(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    barrier.noteUnsyncedChanges(0);
    await barrier.promise;
    expect(settled).toBe(true);
  });
});

describe("Hocuspocus document safety notices", () => {
  it("accepts the defined safety_notice stateless payload", () => {
    expect(
      parseSafetyNotice(
        JSON.stringify({
          type: "safety_notice",
          documentId: "document-1",
          kind: "checkpoint_sweep",
          message: "Content was modified — View change",
          data: { beforeContentRef: 42 },
        }),
      ),
    ).toEqual({
      type: "safety_notice",
      documentId: "document-1",
      kind: "checkpoint_sweep",
      message: "Content was modified — View change",
      data: { beforeContentRef: 42 },
    });
  });

  it("ignores malformed stateless payloads", () => {
    expect(parseSafetyNotice("not json")).toBeNull();
    expect(parseSafetyNotice(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
