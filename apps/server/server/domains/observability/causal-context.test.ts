/** Causal scopes isolate concurrent boundaries and preserve detached async work. */
import { describe, expect, it } from "vitest";
import { CorrelatingEventSink } from "./causal-context.js";
import type { EventRecord } from "./ports/event-sink.js";

function event(eventId: string, traceId?: string): EventRecord {
  return {
    eventId,
    timestamp: "2026-07-18T00:00:00.000Z",
    level: "info",
    source: "test",
    name: "test.event",
    ...(traceId ? { correlation: { traceId } } : {}),
    payload: {},
  };
}

describe("CorrelatingEventSink", () => {
  it("never lets a failing diagnostic adapter veto emit, batch, or flush", async () => {
    const failure = new Error("sink failure");
    const sink = new CorrelatingEventSink({
      emit: () => {
        throw failure;
      },
      emitBatch: () => {
        throw failure;
      },
      flush: () => Promise.reject(failure),
    });

    expect(() => sink.emit(event("event-1"))).not.toThrow();
    expect(() => sink.emitBatch([event("event-2")])).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
