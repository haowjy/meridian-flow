/** Fake-clock coverage of lane independence, completion-relative scheduling, and shutdown.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Independent completion-relative recovery lanes
 */
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
