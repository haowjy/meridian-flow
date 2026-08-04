/** Causal scopes isolate concurrent boundaries and preserve detached async work. */
import { describe, expect, it } from "vitest";
import { InMemoryEventSink } from "./adapters/in-memory/in-memory-event-sink.js";
import { CorrelatingEventSink, runWithEventCorrelation } from "./causal-context.js";
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
  it("isolates concurrent scopes and retains them across detached promises", async () => {
    const delegate = new InMemoryEventSink();
    const sink = new CorrelatingEventSink(delegate);
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const waitA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const waitB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const detachedA = runWithEventCorrelation({ traceId: "trace-a" }, async () => {
      await waitA;
      sink.emit(event("event-a"));
    });
    const detachedB = runWithEventCorrelation({ traceId: "trace-b" }, async () => {
      await waitB;
      sink.emit(event("event-b"));
    });
    releaseB?.();
    releaseA?.();
    await Promise.all([detachedA, detachedB]);

    expect(
      delegate.events.map(({ eventId, correlation }) => [eventId, correlation?.traceId]),
    ).toEqual([
      ["event-b", "trace-b"],
      ["event-a", "trace-a"],
    ]);
  });

  it("keeps the active boundary id and emits a bounded conflict diagnostic", () => {
    const delegate = new InMemoryEventSink();
    const sink = new CorrelatingEventSink(delegate);

    runWithEventCorrelation({ traceId: "boundary-trace" }, () =>
      sink.emit(event("event-1", "caller-trace")),
    );

    expect(delegate.events[0]?.correlation?.traceId).toBe("boundary-trace");
    expect(delegate.events[1]).toMatchObject({
      source: "observability",
      name: "correlation.conflict",
      correlation: { traceId: "boundary-trace" },
      payload: { fields: ["traceId"], conflictCount: 1 },
    });
  });

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
