import { describe, expect, it, vi } from "vitest";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

describe("wakeIfRunnable", () => {
  it("refreshes the queue and starts only work selected at run start", async () => {
    const order: string[] = [];
    const wake = createWakeIfRunnable({
      delivery: {
        async refreshPending() {
          order.push("refresh");
        },
        async selectPending() {
          order.push("select");
          return [
            {
              id: "notice",
              threadId: "thread",
              seq: 1,
              intent: "notice",
              provenance: { kind: "system", source: "work_context" },
              body: { kind: "work_context_refresh" },
              idempotencyKey: "notice",
              enqueuedAt: "2026-01-01T00:00:00.000Z",
              deliveredAt: null,
              runsFirst: false,
            },
          ];
        },
      },
      runStarter: {
        async start() {
          order.push("start");
        },
      },
    });

    await wake("thread");

    expect(order).toEqual(["refresh", "select"]);
  });

  it("starts after rereading when the queue has runnable work", async () => {
    const start = vi.fn();
    const wake = createWakeIfRunnable({
      delivery: {
        async refreshPending() {},
        async selectPending() {
          return [
            {
              id: "message",
              threadId: "thread",
              seq: 1,
              intent: "message",
              provenance: { kind: "writer", actorId: "writer" },
              body: { kind: "text", text: "hello" },
              idempotencyKey: "message",
              enqueuedAt: "2026-01-01T00:00:00.000Z",
              deliveredAt: null,
              runsFirst: false,
            },
          ];
        },
      },
      runStarter: { start },
    });

    await wake("thread");

    expect(start).toHaveBeenCalledWith("thread");
  });
});
