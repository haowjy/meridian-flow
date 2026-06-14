import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryModelRequestDebugStore } from "../adapters/in-memory/in-memory-model-request-debug-store.js";

function sampleRecord(overrides: Partial<ModelRequestDebugRecord> = {}): ModelRequestDebugRecord {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    iteration: 0,
    requestedAt: "2026-06-10T12:00:00.000Z",
    agentSlug: null,
    model: "mock",
    provider: null,
    reasoning: null,
    systemMessages: ["system"],
    skills: [],
    tools: [],
    messageCount: 1,
    ...overrides,
  };
}

describe("InMemoryModelRequestDebugStore", () => {
  it("evicts oldest records when capacity is exceeded", () => {
    const store = createInMemoryModelRequestDebugStore({ capacity: 2 });
    store.record(sampleRecord({ iteration: 0 }));
    store.record(sampleRecord({ iteration: 1 }));
    store.record(sampleRecord({ iteration: 2 }));

    expect(store.listByThread("thread-1").map((record) => record.iteration)).toEqual([1, 2]);
  });

  it("filters listByTurn to one assistant turn", () => {
    const store = createInMemoryModelRequestDebugStore();
    store.record(sampleRecord({ turnId: "turn-a", iteration: 0 }));
    store.record(sampleRecord({ turnId: "turn-b", iteration: 0 }));

    expect(store.listByTurn("thread-1", "turn-a")).toHaveLength(1);
    expect(store.listByTurn("thread-1", "turn-a")[0]?.turnId).toBe("turn-a");
    expect(store.listByTurn("thread-1", "missing")).toEqual([]);
  });
});
