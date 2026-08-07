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
  vi.restoreAllMocks();
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
      pendingEventCapacity: 5,
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
    for (let sequence = 0; sequence < 50; sequence += 1) {
      sink.emit(event(sequence));
    }
    const droppedBytes = Array.from({ length: 45 }, (_, index) => event(index)).reduce(
      (total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"),
      0,
    );

    releaseFirstWrite?.();
    await sink.flush();

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord);
    expect(records).toHaveLength(7);
    expect(records[1]).toMatchObject({
      level: "warn",
      source: "observability",
      name: "sink.dropped",
      payload: { droppedRecords: 45, droppedBytes },
    });
    expect(records[2]?.eventId).toBe("event-45");
    expect(records.at(-1)?.eventId).toBe("event-49");
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
    const sink = new LocalEventSink({ stdout, pendingEventCapacity: 5 });

    sink.emit(event(-1));
    await vi.waitFor(() => expect(stdout.write).toHaveBeenCalledOnce());
    for (let sequence = 0; sequence < 50; sequence += 1) {
      sink.emit(event(sequence));
    }
    const droppedBytes = Array.from({ length: 45 }, (_, index) => event(index)).reduce(
      (total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"),
      0,
    );
    expect(stdout.write).toHaveBeenCalledOnce();

    releaseDrain?.();
    await sink.flush();

    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord);
    expect(records).toHaveLength(7);
    expect(records[0]?.eventId).toBe("event--1");
    expect(records.slice(2).map(({ eventId }) => eventId)).toEqual(
      Array.from({ length: 5 }, (_, index) => `event-${index + 45}`),
    );
    expect(records[1]).toMatchObject({
      level: "warn",
      source: "observability",
      name: "sink.dropped",
      payload: { droppedRecords: 45, droppedBytes },
    });
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

  it("serializes concurrent writers before segment allocation and pruning", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    const sinks = Array.from(
      { length: 4 },
      () =>
        new LocalEventSink({
          dir: directory,
          segmentBytes: 300,
          maxBytes: 600,
          stdout: { write: () => true, once: vi.fn() },
        }),
    );

    sinks.forEach((sink, sinkIndex) => {
      sink.emitBatch(Array.from({ length: 8 }, (_, index) => event(sinkIndex * 10 + index)));
    });
    await Promise.all(sinks.map((sink) => sink.flush()));

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    const sizes = await Promise.all(files.map((file) => stat(path.join(directory, file))));
    expect(sizes.every(({ size }) => size <= 300)).toBe(true);
    expect(sizes.reduce((total, { size }) => total + size, 0)).toBeLessThanOrEqual(600);
  });

  it("keeps segment allocation and pruning correct beyond four digits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    await writeFile(path.join(directory, "2026-08-03-9999.jsonl"), "x".repeat(250));
    const sink = new LocalEventSink({
      dir: directory,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      segmentBytes: 300,
      maxBytes: 600,
      stdout: { write: () => true, once: vi.fn() },
    });

    sink.emit(event(1));
    await sink.flush();

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    const sizes = await Promise.all(files.map((file) => stat(path.join(directory, file))));
    expect(files).toContain("2026-08-03-10000.jsonl");
    expect(sizes.every(({ size }) => size <= 300)).toBe(true);
    expect(sizes.reduce((total, { size }) => total + size, 0)).toBeLessThanOrEqual(600);
  });

  it("parses segment counters beyond Number safe-integer range", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-local-event-sink-"));
    directories.push(directory);
    await writeFile(path.join(directory, "2026-08-03-9007199254740992.jsonl"), "x".repeat(250));
    const sink = new LocalEventSink({
      dir: directory,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      segmentBytes: 300,
      maxBytes: 600,
      stdout: { write: () => true, once: vi.fn() },
    });

    sink.emit(event(1));
    await sink.flush();

    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    const sizes = await Promise.all(files.map((file) => stat(path.join(directory, file))));
    expect(files.sort()).toEqual([
      "2026-08-03-9007199254740992.jsonl",
      "2026-08-03-9007199254740993.jsonl",
    ]);
    expect(sizes.every(({ size }) => size <= 300)).toBe(true);
    expect(sizes.reduce((total, { size }) => total + size, 0)).toBeLessThanOrEqual(600);
  });
});
