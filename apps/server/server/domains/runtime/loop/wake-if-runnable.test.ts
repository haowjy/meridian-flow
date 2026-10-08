import { describe, expect, it, vi } from "vitest";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

describe("wakeIfRunnable", () => {
  it("stops rereading and starting if shutdown begins during refresh", async () => {
    const shutdown = { started: false };
    const selectPending = vi.fn(async () => []);
    const start = vi.fn();
    const wake = createWakeIfRunnable({
      shutdown,
      delivery: {
        async refreshPending() {
          shutdown.started = true;
        },
        selectPending,
      },
      runStarter: { start },
    });

    await wake("thread");

    expect(selectPending).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
