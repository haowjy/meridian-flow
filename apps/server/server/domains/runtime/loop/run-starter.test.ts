/** The best-effort RunStarter: a live run is swallowed, a real failure is not. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { TurnStartConflictError } from "../../threads/index.js";
import { createRunStarter } from "./run-starter.js";

const THREAD = "thread-1" as ThreadId;

describe("createRunStarter", () => {
  it("swallows the already-running conflict", async () => {
    const runStarter = createRunStarter({
      async startDrain(threadId) {
        throw new TurnStartConflictError(threadId, "already_running");
      },
    });

    await expect(runStarter.start(THREAD)).resolves.toBeUndefined();
  });

  it("propagates a non-conflict failure", async () => {
    const runStarter = createRunStarter({
      async startDrain() {
        throw new Error("boom");
      },
    });

    await expect(runStarter.start(THREAD)).rejects.toThrow("boom");
  });
});
