import { describe, expect, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { CollabSyncRuntime } from "@/core/cm6-collab/sync/runtime";

const TEST_DOC_ID = "00000000-0000-0000-0000-000000000001";
const DOC_WS_PREFIX_SYNC = 0x00;

function createTestRuntime() {
  const sentFrames: Uint8Array[] = [];
  const runtime = new CollabSyncRuntime({
    documentId: TEST_DOC_ID,
    sendBinary: (frame) => sentFrames.push(frame),
  });
  return { runtime, sentFrames };
}

describe("CollabSyncRuntime.startSync", () => {
  // [unit-tester:dispose] verification -- safe to delete after passing
  it("sends SyncStep1 on first call", () => {
    const { runtime, sentFrames } = createTestRuntime();
    runtime.startSync();
    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0]?.[0]).toBe(DOC_WS_PREFIX_SYNC);
    expect(runtime.getStatus()).toBe("syncing");
    runtime.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("is idempotent — second call does not send another SyncStep1", () => {
    const { runtime, sentFrames } = createTestRuntime();
    runtime.startSync();
    runtime.startSync();
    expect(sentFrames.length).toBe(1);
    runtime.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
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

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("allows startSync again after reset", () => {
    const sentFrames: Uint8Array[] = [];
    const statusChanges: string[] = [];
    const runtime = new CollabSyncRuntime({
      documentId: TEST_DOC_ID,
      sendBinary: (frame) => sentFrames.push(frame),
      onStatusChange: (status) => statusChanges.push(status),
    });

    runtime.startSync();
    runtime.startSync();
    runtime.reset();
    runtime.startSync();

    expect(sentFrames).toHaveLength(2);
    expect(sentFrames[0]?.[0]).toBe(0x00);
    expect(sentFrames[1]?.[0]).toBe(0x00);
    expect(statusChanges).toEqual(["syncing", "disconnected", "syncing"]);

    runtime.destroy();
  });

  // [unit-tester:dispose] verification -- safe to delete after passing
  it("clears sync lifecycle state on reset so initial sync can complete again", () => {
    const onInitialSyncComplete = vi.fn();
    const statusChanges: string[] = [];
    const trackedRuntime = new CollabSyncRuntime({
      documentId: TEST_DOC_ID,
      sendBinary: vi.fn(),
      onInitialSyncComplete,
      onStatusChange: (status) => statusChanges.push(status),
    });

    trackedRuntime.startSync();
    trackedRuntime.handleBinaryFrame(buildSyncStep2Frame(trackedRuntime));

    expect(trackedRuntime.getStatus()).toBe("connected");
    expect(onInitialSyncComplete).toHaveBeenCalledTimes(1);

    trackedRuntime.reset();
    expect(trackedRuntime.getStatus()).toBe("disconnected");

    trackedRuntime.startSync();
    trackedRuntime.handleBinaryFrame(buildSyncStep2Frame(trackedRuntime));

    expect(onInitialSyncComplete).toHaveBeenCalledTimes(2);
    expect(statusChanges).toEqual([
      "syncing",
      "connected",
      "disconnected",
      "syncing",
      "connected",
    ]);

    trackedRuntime.destroy();
  });
});

function buildSyncStep2Frame(runtime: CollabSyncRuntime): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep2(encoder, runtime.ydoc);
  return withPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder));
}

function withPrefix(prefix: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = prefix;
  framed.set(payload, 1);
  return framed;
}
