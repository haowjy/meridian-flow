/** Fake-clock coverage of lane independence, completion-relative scheduling, and shutdown. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { startRecoveryScheduler } from "./recovery-scheduler.js";

const deferred = () => {
  let resolve!: (count: number) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<number>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("recovery scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts every lane at boot; a slow lane cannot overlap itself or delay another", async () => {
    const slow = deferred();
    const a = vi.fn(() => slow.promise);
    const b = vi.fn(async () => 3);
    const sink = createInMemoryEventSink();
    const scheduler = startRecoveryScheduler(
      [
        { name: "slow", delayMs: 20, run: a },
        { name: "fast", delayMs: 10, run: b },
      ],
      sink,
    );
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(4);
    slow.resolve(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(a).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a).toHaveBeenCalledTimes(2);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        source: "recovery.slow",
        name: "pass.completed",
        payload: { durationMs: 30, count: 2 },
      }),
    );
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes synchronous and asynchronous failures and rearms each failed lane", async () => {
    const sink = createInMemoryEventSink();
    const run = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(() => {
        throw new Error("sync failure");
      })
      .mockRejectedValueOnce(new Error("async failure"))
      .mockResolvedValue(7);
    const scheduler = startRecoveryScheduler([{ name: "repair", delayMs: 10, run }], sink);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sink.events.map((event) => event.name)).toEqual([
      "pass.failed",
      "pass.failed",
      "pass.completed",
    ]);
    expect(sink.events.every((event) => event.source === "recovery.repair")).toBe(true);
    await scheduler.stop();
  });

  it("clears armed timers and waits for in-flight rejection without rearming", async () => {
    const pending = deferred();
    const sink = createInMemoryEventSink();
    const idle = vi.fn(async () => 0);
    const scheduler = startRecoveryScheduler(
      [
        { name: "pending", delayMs: 1, run: () => pending.promise },
        { name: "idle", delayMs: 1, run: idle },
      ],
      sink,
    );
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1); // Only the shutdown deadline, not a rearmed lane.
    pending.reject(new Error("shutdown failure"));
    await stopping;
    expect(sink.events.at(-1)?.name).toBe("pass.failed");
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.stop();
  });
  it("bounds shutdown while observing an abandoned lane's later rejection", async () => {
    const pending = deferred();
    const sink = createInMemoryEventSink();
    const scheduler = startRecoveryScheduler(
      [{ name: "stuck", delayMs: 1, run: () => pending.promise }],
      sink,
    );
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    await stopping;
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        source: "recovery.stuck",
        name: "shutdown.abandoned",
        payload: {},
      }),
    );
    pending.reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.events.at(-1)?.name).toBe("pass.failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
