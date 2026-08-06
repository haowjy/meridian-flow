/** Count, byte, and per-record bounds for content-bearing debug capture. */
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryModelRequestDebugStore } from "./in-memory-model-request-debug-store.js";

function record(iteration: number, text: string): ModelRequestDebugRecord {
  return {
    schema: "meridian.model-request-debug.v1",
    gatewayCallId: `call-${iteration}`,
    threadId: "thread-1",
    turnId: "turn-1",
    iteration,
    requestedAt: new Date(iteration).toISOString(),
    agentSlug: "writer",
    requestDigest: `digest-${iteration}`,
    requestBytes: new TextEncoder().encode(text).byteLength,
    capture: { status: "complete" },
    request: { messages: [{ role: "user", content: [{ type: "text", text }] }] },
    skills: [],
    toolRegistrations: [],
  };
}

describe("InMemoryModelRequestDebugStore", () => {
  it("retains metadata and digest when a canonical request is too large", () => {
    const store = createInMemoryModelRequestDebugStore({ maxRecordBytes: 4 });
    store.record(record(0, "12345"));

    expect(store.listByThread("thread-1")[0]).toMatchObject({
      gatewayCallId: "call-0",
      requestDigest: "digest-0",
      request: null,
      capture: { status: "omitted", reason: "record_too_large", maxRecordBytes: 4 },
    });
  });

  it("evicts oldest records under count and total-byte pressure with exact loss stats", () => {
    const sampleBytes = new TextEncoder().encode(JSON.stringify(record(0, "x"))).byteLength;
    const store = createInMemoryModelRequestDebugStore({
      capacity: 2,
      maxBytes: sampleBytes * 2 + 10,
    });
    store.record(record(0, "x"));
    store.record(record(1, "x"));
    store.record(record(2, "x"));

    expect(store.listByThread("thread-1").map((entry) => entry.iteration)).toEqual([1, 2]);
    expect(store.retention()).toMatchObject({ retainedRecords: 2, droppedRecords: 1 });
    expect(store.retention().droppedBytes).toBeGreaterThan(0);
  });
});
