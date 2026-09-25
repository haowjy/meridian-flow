/** The best-effort RunStarter: a live run is swallowed, a real failure is not. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { TurnStartConflictError } from "../../threads/index.js";
import { createRunStarter } from "./run-starter.js";

const THREAD = "thread-1" as ThreadId;

describe("createRunStarter", () => {
  it("swallows the already-running conflict", async () => {
    const eventSink = createInMemoryEventSink();
    const runStarter = createRunStarter(
      {
        async startDrain(threadId) {
          throw new TurnStartConflictError(threadId, "already_running");
        },
      },
      eventSink,
    );

    await expect(runStarter.start(THREAD)).resolves.toBeUndefined();
  });

  it("reports a non-conflict failure once without rejecting the durable enqueue", async () => {
    const eventSink = createInMemoryEventSink();
    const runStarter = createRunStarter(
      {
        async startDrain() {
          throw new Error("boom");
        },
      },
      eventSink,
    );

    await expect(runStarter.start(THREAD)).resolves.toBeUndefined();
    expect(eventSink.events).toMatchObject([
      { name: "wake.failed", correlation: { threadId: THREAD } },
    ]);
  });
});
