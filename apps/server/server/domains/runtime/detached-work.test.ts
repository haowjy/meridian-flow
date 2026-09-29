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
    tracker.track(first.promise);

    let drained = false;
    const draining = tracker.drain(500).then((result) => {
      drained = result;
    });

    tracker.track(second.promise);
    first.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

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
  });
});
