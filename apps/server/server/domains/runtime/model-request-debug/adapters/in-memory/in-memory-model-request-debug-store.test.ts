/** Count, byte, and per-request bounds for content-bearing debug capture. */
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../../../tools/index.js";
import type { ModelRequestDebugCaptureInput } from "../../build-record.js";
import { createInMemoryModelRequestDebugStore } from "./in-memory-model-request-debug-store.js";

function input(iteration: number, text: string): ModelRequestDebugCaptureInput {
  return {
    gatewayCallId: `call-${iteration}`,
    threadId: "thread-1",
    turnId: "turn-1",
    iteration,
    agentSlug: "writer",
    request: { messages: [{ role: "user", content: [{ type: "text", text }] }] },
    resolvedSkills: [],
    toolRegistry: createToolRegistry(),
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("InMemoryModelRequestDebugStore", () => {
  it("retains metadata and digest without parsing an oversized canonical request", () => {
    const store = createInMemoryModelRequestDebugStore({ maxRequestBytes: 4 });
    store.capture(input(0, "12345"));

    expect(store.listByThread("thread-1")[0]).toMatchObject({
      gatewayCallId: "call-0",
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      request: null,
      capture: { status: "omitted", reason: "request_too_large", maxRequestBytes: 4 },
    });
  });

  it("evicts the oldest record at the count limit with exact loss stats", () => {
    const store = createInMemoryModelRequestDebugStore({ capacity: 2 });
    store.capture(input(0, "x"));
    const firstBytes = bytes(store.listByThread("thread-1")[0]);
    store.capture(input(1, "x"));
    store.capture(input(2, "x"));

    expect(store.listByThread("thread-1").map((entry) => entry.iteration)).toEqual([1, 2]);
    expect(store.retention()).toMatchObject({
      retainedRecords: 2,
      droppedRecords: 1,
      droppedBytes: firstBytes,
    });
  });

  it("evicts solely under total-byte pressure and accounts for every byte", () => {
    const sizingStore = createInMemoryModelRequestDebugStore();
    sizingStore.capture(input(0, "x"));
    sizingStore.capture(input(1, "a longer request"));
    const [first, second] = sizingStore.listByThread("thread-1");
    const firstBytes = bytes(first);
    const secondBytes = bytes(second);

    const store = createInMemoryModelRequestDebugStore({ capacity: 10, maxBytes: secondBytes });
    store.capture(input(0, "x"));
    store.capture(input(1, "a longer request"));

    expect(store.listByThread("thread-1").map((entry) => entry.iteration)).toEqual([1]);
    expect(store.retention()).toEqual({
      retainedRecords: 1,
      retainedBytes: secondBytes,
      droppedRecords: 1,
      droppedBytes: firstBytes,
    });
  });

  it("drops a metadata-only record that cannot fit the total ceiling", () => {
    const sizingStore = createInMemoryModelRequestDebugStore({ maxRequestBytes: 1 });
    sizingStore.capture(input(0, "x"));
    const omittedBytes = bytes(sizingStore.listByThread("thread-1")[0]);

    const store = createInMemoryModelRequestDebugStore({
      maxRequestBytes: 1,
      maxBytes: omittedBytes - 1,
    });
    store.capture(input(0, "x"));

    expect(store.listByThread("thread-1")).toEqual([]);
    expect(store.retention()).toEqual({
      retainedRecords: 0,
      retainedBytes: 0,
      droppedRecords: 1,
      droppedBytes: omittedBytes,
    });
  });
});
