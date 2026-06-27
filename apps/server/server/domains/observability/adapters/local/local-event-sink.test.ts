import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventRecord } from "../../ports/event-sink.js";
import { LocalEventSink } from "./local-event-sink.js";

const tempDirs: string[] = [];

function event(name: string): EventRecord {
  return {
    timestamp: "2026-06-27T12:00:00.000Z",
    level: "info",
    source: "test",
    name,
    payload: { ok: true },
  };
}

async function makeLogDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-local-event-sink-"));
  tempDirs.push(dir);
  return dir;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalEventSink", () => {
  it("writes daily JSONL files and prunes files outside the retention window", async () => {
    const dir = await makeLogDir();
    await writeFile(path.join(dir, "2026-06-20.jsonl"), "old\n");
    await writeFile(path.join(dir, "2026-06-25.jsonl"), "kept\n");
    await writeFile(path.join(dir, "not-a-log.txt"), "kept\n");
    const stdout = { write: () => true };
    const sink = new LocalEventSink({
      dir,
      retentionDays: 3,
      now: () => new Date("2026-06-27T08:00:00.000Z"),
      stdout,
    });

    sink.emit(event("retention.test"));
    await sink.flush();

    expect(await exists(path.join(dir, "2026-06-20.jsonl"))).toBe(false);
    expect(await exists(path.join(dir, "2026-06-25.jsonl"))).toBe(true);
    expect(await exists(path.join(dir, "not-a-log.txt"))).toBe(true);
    const today = await readFile(path.join(dir, "2026-06-27.jsonl"), "utf8");
    expect(today).toContain('"name":"retention.test"');
  });

  it("rotates files by UTC day", async () => {
    const dir = await makeLogDir();
    let now = new Date("2026-06-27T23:59:59.000Z");
    const sink = new LocalEventSink({
      dir,
      retentionDays: 7,
      now: () => now,
      stdout: { write: () => true },
    });

    sink.emit(event("before_midnight"));
    await sink.flush();
    now = new Date("2026-06-28T00:00:00.000Z");
    sink.emit(event("after_midnight"));
    await sink.flush();

    expect(await readFile(path.join(dir, "2026-06-27.jsonl"), "utf8")).toContain(
      '"name":"before_midnight"',
    );
    expect(await readFile(path.join(dir, "2026-06-28.jsonl"), "utf8")).toContain(
      '"name":"after_midnight"',
    );
  });
});
