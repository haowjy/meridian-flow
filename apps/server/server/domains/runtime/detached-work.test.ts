import { describe, expect, it } from "vitest";
import { createDetachedWorkTracker } from "./detached-work.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("detached work tracker", () => {
  it("waits for tracked work and work registered before it becomes quiescent", async () => {
    const tracker = createDetachedWorkTracker();
    const first = deferred();
    const second = deferred();
    tracker.track(first.promise, "first task");

    let drained = false;
    const draining = tracker.drain(500).then((result) => {
      drained = result;
    });

    tracker.track(second.promise, "second task");
    first.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(tracker.pendingTasks).toEqual(["first task", "second task"]);

    second.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(tracker.pendingCount).toBe(0);
  });

  it("returns false when tracked work exceeds the timeout", async () => {
    const tracker = createDetachedWorkTracker();
    const task = deferred();
    tracker.track(task.promise);

    await expect(tracker.drain(1)).resolves.toBe(false);
    task.resolve();
    await tracker.drain();
    expect(tracker.pendingTasks).toEqual([]);
  });
});
