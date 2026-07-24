/** TeeEventSink fan-out contract tests. */
import { describe, expect, it, vi } from "vitest";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { TeeEventSink } from "./tee-event-sink.js";

function recordingSink() {
  const events: EventRecord[] = [];
  const flush = vi.fn(async () => undefined);
  const sink: EventSink = {
    emit: (event) => events.push(event),
    emitBatch: (batch) => events.push(...batch),
    flush,
  };
  return { events, flush, sink };
}

describe("TeeEventSink", () => {
  it("fans emit, emitBatch, and flush out to every sink", async () => {
    const first = recordingSink();
    const second = recordingSink();
    const tee = new TeeEventSink([first.sink, second.sink]);
    const one = { eventId: "1" } as EventRecord;
    const two = { eventId: "2" } as EventRecord;

    tee.emit(one);
    tee.emitBatch([two]);
    await tee.flush();

    expect(first.events).toEqual([one, two]);
    expect(second.events).toEqual([one, two]);
    expect(first.flush).toHaveBeenCalledOnce();
    expect(second.flush).toHaveBeenCalledOnce();
  });
});
