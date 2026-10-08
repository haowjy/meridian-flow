/** Stalled platform stdout must bound pending work and resume with the newest retained events. */
import { expect, it, vi } from "vitest";
import type { EventRecord } from "../../ports/event-sink.js";
import { LocalEventSink } from "./local-event-sink.js";

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
