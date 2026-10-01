import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord, EventSink } from "../domains/observability/index.js";
import {
  APP_DRAIN_DEADLINE_MS,
  POLLING_LOOPS_SHUTDOWN_TIMEOUT_MS,
  runShutdownSteps,
  withDeadline,
} from "./process-shutdown.js";

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
  afterEach(() => vi.useRealTimers());

  it("continues to later stages after an individual stage times out", async () => {
    const events: EventRecord[] = [];
    const visited: string[] = [];
    const failed = await runShutdownSteps(
      [
        {
          name: "websocket-admission",
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
    expect(events.map(({ name }) => name)).toContain("shutdown.incomplete.websocket-admission");
    expect(events.map(({ name }) => name)).toContain("shutdown.database-close.completed");
  });

  it("caps polling-loop drain at three seconds before later stages", async () => {
    const events: EventRecord[] = [];
    const visited: string[] = [];
    const failed = await runShutdownSteps(
      [
        {
          name: "polling-loops",
          timeoutMs: POLLING_LOOPS_SHUTDOWN_TIMEOUT_MS,
          callback: () => new Promise<void>(() => {}),
        },
        {
          name: "websocket-drain",
          callback: () => {
            visited.push("websocket-drain");
          },
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

    expect(POLLING_LOOPS_SHUTDOWN_TIMEOUT_MS).toBe(3_000);
    expect(failed).toBe(true);
    expect(visited).toEqual(["websocket-drain", "database-close"]);
    expect(events.map(({ name }) => name)).toContain("shutdown.incomplete.polling-loops");
  });

  it("gives application settlement its full budget before closing the database", async () => {
    vi.useFakeTimers();
    const events: EventRecord[] = [];
    const visited: string[] = [];
    const shutdown = runShutdownSteps(
      [
        {
          name: "application-drain",
          timeoutMs: APP_DRAIN_DEADLINE_MS,
          callback: () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                visited.push("settled");
                resolve();
              }, 3_500),
            ),
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

    await vi.advanceTimersByTimeAsync(3_500);

    await expect(shutdown).resolves.toBe(false);
    expect(APP_DRAIN_DEADLINE_MS).toBe(10_000);
    expect(visited).toEqual(["settled", "database-close"]);
  });

  it("continues shutdown when application settlement exceeds its budget", async () => {
    vi.useFakeTimers();
    const events: EventRecord[] = [];
    const visited: string[] = [];
    const shutdown = runShutdownSteps(
      [
        {
          name: "application-drain",
          timeoutMs: APP_DRAIN_DEADLINE_MS,
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

    await vi.advanceTimersByTimeAsync(APP_DRAIN_DEADLINE_MS);

    await expect(shutdown).resolves.toBe(true);
    expect(visited).toEqual(["database-close"]);
    expect(events.map(({ name }) => name)).toContain("shutdown.incomplete.application-drain");
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
