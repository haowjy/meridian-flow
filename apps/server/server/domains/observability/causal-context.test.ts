/** Consolidated test contracts; each block retains its original fixture scope. */

import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { LocalEventSink } from "./adapters/local/local-event-sink.js";
import { CorrelatingEventSink } from "./causal-context.js";
import type { EventRecord } from "./ports/event-sink.js";

__mergedSuite("causal-context.test.ts", () => {
  // Merged from apps/server/server/domains/observability/causal-context.test.ts.
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

  __mergedSuite("CorrelatingEventSink", () => {
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
});

__mergedSuite("local-event-sink.test.ts", () => {
  // Merged from apps/server/server/domains/observability/adapters/local/local-event-sink.test.ts.
  function event(sequence: number): EventRecord {
    return {
      eventId: `event-${sequence}`,
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      source: "test",
      name: "event",
      payload: { sequence },
    };
  }

  it("waits for stdout drain while retaining only the bounded pending queue", async () => {
    const output: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const sink = new LocalEventSink({
      pendingEventCapacity: 5,
      stdout: {
        write(chunk) {
          output.push(chunk);
          return output.length > 1;
        },
        once(_event, listener) {
          releaseDrain = listener;
        },
      },
    });
    sink.emit(event(-1));
    await vi.waitFor(() => expect(output).toHaveLength(1));
    for (let sequence = 0; sequence < 50; sequence++) sink.emit(event(sequence));
    expect(output).toHaveLength(1);
    if (!releaseDrain) throw new Error("Sink did not wait for stdout drain");
    releaseDrain();
    await sink.flush();
    const records = output
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord);
    expect(records).toHaveLength(7);
    expect(records[0]?.eventId).toBe("event--1");
    expect(records.slice(2).map(({ eventId }) => eventId)).toEqual([
      "event-45",
      "event-46",
      "event-47",
      "event-48",
      "event-49",
    ]);
    const droppedBytes = Array.from({ length: 45 }, (_, sequence) => event(sequence)).reduce(
      (total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"),
      0,
    );
    expect(records[1]).toMatchObject({
      level: "warn",
      source: "observability",
      name: "sink.dropped",
      payload: { droppedRecords: 45, droppedBytes },
    });
  });
});
