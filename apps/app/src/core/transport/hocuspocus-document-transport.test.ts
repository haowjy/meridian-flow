import { describe, expect, it } from "vitest";

import { createDurableSyncBarrier } from "./hocuspocus-document-transport";

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
