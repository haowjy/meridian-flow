/** LocalEventSink queue bounds and serialized mirror behavior. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../ports/event-sink.js";
import { LocalEventSink } from "./local-event-sink.js";

const directories: string[] = [];

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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("LocalEventSink", () => {
  it("bounds a stalled mirror queue and reports oldest-event drops", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteStalled = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const appendFile = vi
      .fn()
      .mockImplementationOnce(() => firstWriteStalled)
      .mockResolvedValue(undefined);
    let output = "";
    const sink = new LocalEventSink({
      dir: directory,
      appendFile,
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    });

    sink.emit(event(-1));
    await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
    for (let sequence = 0; sequence < 50_000; sequence += 1) {
      sink.emit(event(sequence));
    }

    const state = sink as unknown as {
      pendingEvents: EventRecord[];
      droppedEvents: number;
    };
    expect(state.pendingEvents).toHaveLength(5_000);
    expect(state.droppedEvents).toBe(45_000);

    releaseFirstWrite?.();
    await sink.flush();

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord);
    expect(records).toHaveLength(5_002);
    expect(records[1]).toMatchObject({
      level: "warn",
      source: "observability",
      name: "sink.dropped",
      payload: { dropped: 45_000 },
    });
    expect(records[2]?.eventId).toBe("event-45000");
    expect(records.at(-1)?.eventId).toBe("event-49999");
    expect(state.droppedEvents).toBe(0);
  });

  it("preserves emitBatch and flush on the normal path", async () => {
    let output = "";
    const sink = new LocalEventSink({
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
      },
    });

    sink.emit(event(1));
    sink.emitBatch([event(2), event(3)]);
    await sink.flush();

    expect(
      output
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as EventRecord).eventId),
    ).toEqual(["event-1", "event-2", "event-3"]);
  });
});
