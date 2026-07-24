/** emitEvent contract tests for call-site identity and timestamp stamping. */
import { describe, expect, it } from "vitest";
import { emitEvent } from "./emit-event.js";
import type { EventRecord, EventSink } from "./ports/event-sink.js";

describe("emitEvent", () => {
  it("assigns an event id at emit time and preserves a supplied id", () => {
    const events: EventRecord[] = [];
    const sink: EventSink = {
      emit: (event) => events.push(event),
      emitBatch: (batch) => events.push(...batch),
      flush: async () => undefined,
    };

    emitEvent(sink, {
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      source: "test",
      name: "generated",
      payload: {},
    });
    emitEvent(sink, {
      eventId: "fixture-id",
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      source: "test",
      name: "preserved",
      payload: {},
    });

    expect(events[0]?.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(events[1]?.eventId).toBe("fixture-id");
  });
});
