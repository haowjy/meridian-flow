/**
 * The production `RunStarter`: a best-effort wake that starts a drain-only run
 * for a thread. The wake is fired after a steer enqueues (latency) and by the
 * sweep (durability); this adapter is the latency half. A conflict means a run
 * is already live (or another run won the lease), which is exactly the state a
 * wake wanted, so it is swallowed.
 */
import { TurnStartConflictError } from "../../threads/index.js";
import type { RunStarter } from "./ports.js";
import type { TurnRunner } from "./turn-runner.js";

export function createRunStarter(runner: Pick<TurnRunner, "startDrain">): RunStarter {
  return {
    async start(threadId) {
      try {
        await runner.startDrain(threadId);
      } catch (error) {
        if (error instanceof TurnStartConflictError) return;
        throw error;
      }
    },
  };
}
