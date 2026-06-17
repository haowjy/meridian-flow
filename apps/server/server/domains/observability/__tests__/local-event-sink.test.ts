import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEventSink } from "../adapters/local/local-event-sink.js";
import type { EventRecord } from "../ports/event-sink.js";

const dirs: string[] = [];

function discardStdout(): Pick<NodeJS.WriteStream, "write"> {
  return { write: () => true } as Pick<NodeJS.WriteStream, "write">;
}

function sampleEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    timestamp: "2026-06-10T12:00:00.000Z",
    level: "error",
    source: "runtime.orchestrator",
    name: "tool.output_delta.append_failed",
    payload: { threadId: "thread-1", message: "disk full" },
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `meridian-local-sink-${crypto.randomUUID()}`);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("LocalEventSink", () => {
  it("writes one JSON object per line with the full record shape", async () => {
    const dir = await tempDir();
    const sink = new LocalEventSink({
      dir,
      now: () => new Date("2026-06-10T08:30:00.000Z"),
      stdout: discardStdout(),
    });

    const event = sampleEvent();
    sink.emit(event);
    await sink.flush();

    const filePath = sink.currentFilePath();
    expect(filePath).toBe(path.join(dir, "2026-06-10.jsonl"));
    if (!filePath) throw new Error("missing JSONL file path");

    const raw = await readFile(filePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (!line) throw new Error("missing JSONL line");
    expect(JSON.parse(line)).toEqual({
      ...event,
      eventId: expect.any(String),
      sensitivity: "safe",
    });
  });

  it("appends batch emits as separate JSONL lines", async () => {
    const dir = await tempDir();
    const sink = new LocalEventSink({
      dir,
      now: () => new Date("2026-06-10T00:00:00.000Z"),
      stdout: discardStdout(),
    });

    sink.emitBatch([
      sampleEvent({ name: "first", level: "info" }),
      sampleEvent({ name: "second", level: "warn" }),
    ]);
    await sink.flush();

    const filePath = sink.currentFilePath();
    if (!filePath) throw new Error("missing JSONL file path");
    const raw = await readFile(filePath, "utf8");
    const parsed = raw
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as EventRecord);

    expect(parsed.map((event) => event.name)).toEqual(["first", "second"]);
    expect(parsed.every((event) => event.source === "runtime.orchestrator")).toBe(true);
  });

  it("serializes concurrent emits so every line remains valid JSON", async () => {
    const dir = await tempDir();
    const sink = new LocalEventSink({
      dir,
      now: () => new Date("2026-06-10T00:00:00.000Z"),
      stdout: discardStdout(),
    });

    const count = 40;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        Promise.resolve().then(() => {
          sink.emit(sampleEvent({ name: `event-${index}`, payload: { index } }));
        }),
      ),
    );
    await sink.flush();

    const filePath = sink.currentFilePath();
    if (!filePath) throw new Error("missing JSONL file path");
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(count);

    for (const line of lines) {
      const parsed = JSON.parse(line) as EventRecord;
      expect(parsed.payload.index).toBeTypeOf("number");
      expect(parsed.name).toMatch(/^event-\d+$/);
    }
  });

  it("writes stdout without requiring LOG_DIR", async () => {
    const writes: string[] = [];
    const sink = new LocalEventSink({
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        },
      } as Pick<NodeJS.WriteStream, "write">,
    });

    sink.emit(sampleEvent({ name: "stdout_only" }));
    await sink.flush();

    expect(sink.currentFilePath()).toBeNull();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({ name: "stdout_only" });
  });
});
