import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../adapters/in-memory/in-memory-event-sink.js";
import { createNoopEventSink } from "../adapters/noop/noop-event-sink.js";
import type { EventRecord } from "../ports/event-sink.js";

const event: EventRecord = {
  timestamp: "2026-06-10T12:00:00.000Z",
  level: "info",
  source: "lib.startup",
  name: "api.started",
  payload: { port: 4000 },
};

describe("InMemoryEventSink", () => {
  it("records single and batch emits in order", async () => {
    const sink = createInMemoryEventSink();

    sink.emit(event);
    sink.emitBatch([
      { ...event, name: "second" },
      { ...event, name: "third" },
    ]);
    await sink.flush();

    expect(sink.events).toHaveLength(3);
    expect(sink.events.map((record) => record.name)).toEqual(["api.started", "second", "third"]);
  });
});

describe("NoopEventSink", () => {
  it("accepts emits without retaining them", async () => {
    const sink = createNoopEventSink();

    sink.emit(event);
    sink.emitBatch([event, event]);
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
