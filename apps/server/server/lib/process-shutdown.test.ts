import { describe, expect, it } from "vitest";
import type { EventRecord, EventSink } from "../domains/observability/index.js";
import { runShutdownSteps, withDeadline } from "./process-shutdown.js";

function testEventSink(events: EventRecord[]): EventSink {
  return {
    emit(event) {
      events.push(event);
    },
    emitBatch(batch) {
      events.push(...batch);
    },
    async flush() {},
  };
}

describe("process shutdown", () => {
  it("continues to later stages after an individual stage times out", async () => {
    const events: EventRecord[] = [];
    const visited: string[] = [];
    const failed = await runShutdownSteps(
      [
        {
          name: "turn-drain",
          timeoutMs: 1,
          callback: () => new Promise<void>(() => {}),
        },
        {
          name: "database-close",
          callback: () => {
            visited.push("database-close");
          },
        },
      ],
      { eventSink: testEventSink(events), signal: "SIGTERM" },
    );

    expect(failed).toBe(true);
    expect(visited).toEqual(["database-close"]);
    expect(events.map(({ name }) => name)).toContain("shutdown.incomplete.turn-drain");
    expect(events.map(({ name }) => name)).toContain("shutdown.database-close.completed");
  });

  it("reports completed, failed, and expired deadline work consistently", async () => {
    await expect(withDeadline(() => 42, Date.now() + 100)).resolves.toEqual({
      status: "completed",
      value: 42,
    });
    await expect(
      withDeadline(() => Promise.reject(new Error("failed")), Date.now() + 100),
    ).resolves.toMatchObject({
      status: "failed",
      error: { message: "failed" },
    });
    await expect(withDeadline(() => new Promise(() => {}), Date.now() + 1)).resolves.toEqual({
      status: "deadline",
    });
  });
});
