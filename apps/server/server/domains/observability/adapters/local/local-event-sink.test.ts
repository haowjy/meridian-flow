/** LocalEventSink queue bounds and serialized mirror behavior. */
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
        once: vi.fn(),
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
      droppedBytes: number;
    };
    expect(state.pendingEvents).toHaveLength(5_000);
    expect(state.droppedEvents).toBe(45_000);
    const droppedBytes = state.droppedBytes;

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
      payload: { droppedRecords: 45_000, droppedBytes },
    });
    expect(records[2]?.eventId).toBe("event-45000");
    expect(records.at(-1)?.eventId).toBe("event-49999");
    expect(state.droppedEvents).toBe(0);
  });

  it("waits for stdout drain while retaining only the bounded pending queue", async () => {
    let output = "";
    let releaseDrain: (() => void) | undefined;
    let writeCalls = 0;
    const stdout = {
      write: vi.fn((chunk: string) => {
        output += chunk;
        writeCalls += 1;
        return writeCalls > 1;
      }),
      once: vi.fn((_event: "drain", listener: () => void) => {
        releaseDrain = listener;
      }),
    };
    const sink = new LocalEventSink({ stdout });

    sink.emit(event(-1));
    await vi.waitFor(() => expect(stdout.write).toHaveBeenCalledOnce());
    for (let sequence = 0; sequence < 50_000; sequence += 1) {
      sink.emit(event(sequence));
    }

    const state = sink as unknown as {
      pendingEvents: EventRecord[];
      droppedEvents: number;
      droppedBytes: number;
    };
    expect(state.pendingEvents).toHaveLength(5_000);
    expect(state.droppedEvents).toBe(45_000);
    const droppedBytes = state.droppedBytes;
    expect(stdout.write).toHaveBeenCalledOnce();

    releaseDrain?.();
    await sink.flush();

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord);
    expect(records).toHaveLength(5_002);
    expect(records[0]?.eventId).toBe("event--1");
    expect(records.slice(2).map(({ eventId }) => eventId)).toEqual(
      Array.from({ length: 5_000 }, (_, index) => `event-${index + 45_000}`),
    );
    expect(records[1]).toMatchObject({
      level: "warn",
      source: "observability",
      name: "sink.dropped",
      payload: { droppedRecords: 45_000, droppedBytes },
    });
    expect(state.droppedEvents).toBe(0);
  });

  it("keeps byte-loss accounting added while an earlier summary is writing", async () => {
    let output = "";
    let releaseFirstWrite: (() => void) | undefined;
    let releaseSecondWrite: (() => void) | undefined;
    const firstWriteStalled = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const secondWriteStalled = new Promise<void>((resolve) => {
      releaseSecondWrite = resolve;
    });
    const appendFile = vi
      .fn()
      .mockImplementationOnce(() => firstWriteStalled)
      .mockImplementationOnce(() => secondWriteStalled)
      .mockResolvedValue(undefined);
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    const sink = new LocalEventSink({
      dir: directory,
      appendFile,
      pendingEventCapacity: 2,
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
        once: vi.fn(),
      },
    });

    sink.emit(event(-1));
    await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
    sink.emitBatch([event(0), event(1), event(2), event(3)]);
    releaseFirstWrite?.();
    await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(2));
    sink.emitBatch([event(4), event(5), event(6), event(7)]);
    releaseSecondWrite?.();
    await sink.flush();

    const summaries = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord)
      .filter(({ name }) => name === "sink.dropped");
    expect(summaries).toHaveLength(2);
    expect(summaries.map(({ payload }) => payload.droppedRecords)).toEqual([2, 2]);
    expect(summaries.every(({ payload }) => Number(payload.droppedBytes) > 0)).toBe(true);
  });

  it("preserves emitBatch and flush on the normal path", async () => {
    let output = "";
    const sink = new LocalEventSink({
      stdout: {
        write: (chunk) => {
          output += String(chunk);
          return true;
        },
        once: vi.fn(),
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

  it("rotates bounded segments and prunes old and over-budget files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    await writeFile(path.join(directory, "2026-06-01-0000.jsonl"), "old".repeat(100));
    await writeFile(path.join(directory, "2026-07-18-0000.jsonl"), "recent".repeat(80));
    let now = new Date("2026-07-18T00:00:00.000Z");
    const sink = new LocalEventSink({
      dir: directory,
      now: () => now,
      retentionDays: 14,
      segmentBytes: 600,
      maxBytes: 1_200,
      stdout: { write: () => true, once: vi.fn() },
    });

    sink.emitBatch(Array.from({ length: 12 }, (_, index) => event(index)));
    await sink.flush();
    now = new Date("2026-07-19T00:00:00.000Z");
    sink.emit(event(20));
    await sink.flush();

    const files = (await readdir(directory)).sort();
    const sizes = await Promise.all(files.map((file) => stat(path.join(directory, file))));
    expect(files).not.toContain("2026-06-01-0000.jsonl");
    expect(sizes.every(({ size }) => size <= 600)).toBe(true);
    expect(sizes.reduce((total, { size }) => total + size, 0)).toBeLessThanOrEqual(1_200);
  });

  it("removes the active full segment when the total cap permits only one", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    const sink = new LocalEventSink({
      dir: directory,
      segmentBytes: 220,
      maxBytes: 220,
      stdout: { write: () => true, once: vi.fn() },
    });

    sink.emit(event(1));
    await sink.flush();
    sink.emit(event(2));
    await sink.flush();

    const files = await readdir(directory);
    const sizes = await Promise.all(files.map((file) => stat(path.join(directory, file))));
    expect(sizes.reduce((total, { size }) => total + size, 0)).toBeLessThanOrEqual(220);
  });
});
