import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord, EventSink } from "../domains/observability/index.js";
import {
  assertShutdownStepOrder,
  OBSERVABILITY_FLUSH_BUDGET_MS,
  PROCESS_SHUTDOWN_DEADLINE_MS,
  runShutdownSteps,
  SHUTDOWN_PLAN,
  SRVX_FORCE_CLOSE_SECONDS,
  WEBSOCKET_DRAIN_RESERVED_MS,
  withDeadline,
} from "./process-shutdown.js";

function budget(stage: (typeof SHUTDOWN_PLAN)[number]["stage"]): number {
  const planned = SHUTDOWN_PLAN.find((step) => step.stage === stage);
  if (!planned) throw new Error(`Missing shutdown stage ${stage}`);
  return planned.budgetMs;
}

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
          stage: "websocket-admission",
          callback: () => new Promise<void>(() => {}),
        },
        {
          stage: "database-close",
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
          stage: "polling-loops",
          callback: () => new Promise<void>(() => {}),
        },
        {
          stage: "websocket-drain",
          callback: () => {
            visited.push("websocket-drain");
          },
        },
        {
          stage: "database-close",
          callback: () => {
            visited.push("database-close");
          },
        },
      ],
      { eventSink: testEventSink(events), signal: "SIGTERM" },
    );

    expect(budget("polling-loops")).toBe(3_000);
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
          stage: "application-drain",
          callback: () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                visited.push("settled");
                resolve();
              }, 3_500),
            ),
        },
        {
          stage: "database-close",
          callback: () => {
            visited.push("database-close");
          },
        },
      ],
      { eventSink: testEventSink(events), signal: "SIGTERM" },
    );

    await vi.advanceTimersByTimeAsync(3_500);

    await expect(shutdown).resolves.toBe(false);
    expect(budget("application-drain")).toBe(10_000);
    expect(visited).toEqual(["settled", "database-close"]);
  });

  it("continues shutdown when application settlement exceeds its budget", async () => {
    vi.useFakeTimers();
    const events: EventRecord[] = [];
    const visited: string[] = [];
    const shutdown = runShutdownSteps(
      [
        {
          stage: "application-drain",
          callback: () => new Promise<void>(() => {}),
        },
        {
          stage: "database-close",
          callback: () => {
            visited.push("database-close");
          },
        },
      ],
      { eventSink: testEventSink(events), signal: "SIGTERM" },
    );

    await vi.advanceTimersByTimeAsync(budget("application-drain"));

    await expect(shutdown).resolves.toBe(true);
    expect(visited).toEqual(["database-close"]);
    expect(events.map(({ name }) => name)).toContain("shutdown.incomplete.application-drain");
  });

  it("reserves every stage and flush inside the global deadline", () => {
    expect(SHUTDOWN_PLAN.map(({ stage }) => stage)).toEqual([
      "websocket-admission",
      "polling-loops",
      "application-drain",
      "http-drain",
      "websocket-drain",
      "database-close",
    ]);
    expect(budget("websocket-drain")).toBe(WEBSOCKET_DRAIN_RESERVED_MS);
    expect(
      SHUTDOWN_PLAN.reduce((total, step) => total + step.budgetMs, 0) +
        OBSERVABILITY_FLUSH_BUDGET_MS,
    ).toBeLessThanOrEqual(PROCESS_SHUTDOWN_DEADLINE_MS);
    expect(PROCESS_SHUTDOWN_DEADLINE_MS).toBeLessThan(SRVX_FORCE_CLOSE_SECONDS * 1_000);
  });

  it("rejects shutdown callbacks outside the declared stage order", () => {
    expect(() =>
      assertShutdownStepOrder([
        { stage: "database-close", callback() {} },
        { stage: "application-drain", callback() {} },
      ]),
    ).toThrow("follow SHUTDOWN_PLAN order");
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
