import { describe, it, expect, vi } from "vitest";
import { CollabSyncRuntime } from "@/core/cm6-collab/sync/runtime";

const TEST_DOC_ID = "00000000-0000-0000-0000-000000000001";

function createTestRuntime() {
  const sentFrames: Uint8Array[] = [];
  const runtime = new CollabSyncRuntime({
    documentId: TEST_DOC_ID,
    sendBinary: (frame) => sentFrames.push(frame),
  });
  return { runtime, sentFrames };
}

describe("CollabSyncRuntime.startSync", () => {
  it("sends SyncStep1 on first call", () => {
    const { runtime, sentFrames } = createTestRuntime();
    runtime.startSync();
    expect(sentFrames.length).toBe(1);
    expect(runtime.getStatus()).toBe("syncing");
    runtime.destroy();
  });

  it("is idempotent — second call does not send another SyncStep1", () => {
    const { runtime, sentFrames } = createTestRuntime();
    runtime.startSync();
    runtime.startSync();
    expect(sentFrames.length).toBe(1);
    runtime.destroy();
  });

  it("sets status to syncing only on first call", () => {
    const statusChanges: string[] = [];
    const runtime = new CollabSyncRuntime({
      documentId: TEST_DOC_ID,
      sendBinary: vi.fn(),
      onStatusChange: (s) => statusChanges.push(s),
    });
    runtime.startSync();
    runtime.startSync();
    // Only one "syncing" status change
    expect(statusChanges).toEqual(["syncing"]);
    runtime.destroy();
  });
});
