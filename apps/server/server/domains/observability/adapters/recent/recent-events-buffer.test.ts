/** Recent query history remains bounded by both record count and serialized bytes. */
import { describe, expect, it } from "vitest";
import type { EventRecord } from "../../ports/event-sink.js";
import { serializedEventBytes } from "../../safe-event.js";
import { RecentEventsBuffer } from "./recent-events-buffer.js";

function event(sequence: number, payload = "x"): EventRecord {
  return {
    eventId: `event-${sequence}`,
    timestamp: "2026-07-18T00:00:00.000Z",
    level: "info",
    source: "test",
    name: "event",
    correlation: { traceId: `trace-${sequence % 2}` },
    payload: { payload },
  };
}

describe("RecentEventsBuffer", () => {
  it("evicts by bytes and reports record and byte loss", () => {
    const first = event(1, "a".repeat(100));
    const second = event(2, "b".repeat(100));
    const buffer = new RecentEventsBuffer(10, serializedEventBytes(second) + 1);

    buffer.emit(first);
    buffer.emit(second);

    expect(buffer.query({})).toEqual({
      events: [second],
      dropped: 1,
      droppedBytes: serializedEventBytes(first),
    });
  });

  it("filters one exact event id", () => {
    const buffer = new RecentEventsBuffer();
    buffer.emitBatch([event(1), event(2)]);

    expect(buffer.query({ eventId: "event-1" }).events).toEqual([event(1)]);
  });
});
