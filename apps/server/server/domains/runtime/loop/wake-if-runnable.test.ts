import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryInbox } from "../adapters/in-memory/loop-ports.js";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

describe("wakeIfRunnable", () => {
  it("does not start if shutdown begins while the queue is read", async () => {
    const shutdown = { started: false };
    const inbox = createInMemoryInbox();
    await inbox.enqueue({
      threadId: "thread" as ThreadId,
      intent: "message",
      provenance: { kind: "writer", actorId: "user-1" },
      body: { kind: "text", text: "hi" },
      idempotencyKey: "k",
    });
    const selectPending = vi.fn(async (id: ThreadId) => {
      shutdown.started = true;
      return inbox.selectPending(id);
    });
    const start = vi.fn();
    const wake = createWakeIfRunnable({
      shutdown,
      delivery: { selectPending },
      runStarter: { start },
    });

    await wake("thread" as ThreadId);

    expect(start).not.toHaveBeenCalled();
  });
});
