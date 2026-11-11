/**
 * The bounded-attempt owner: a miss leaves its commit scope before the next
 * attempt captures anything (a retry never computes under the failed attempt's locks), and
 * every candidate a failed attempt owned is disposed, one whose own write succeeded inside
 * the rolled-back scope included. A second owner cannot start inside a commit scope.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Draft attempt unwind and ownership transfer
 */
import { describe, expect, it } from "vitest";
import { NestedAttemptError, runBoundedAttempts } from "./draft-attempts.js";

describe("runBoundedAttempts", () => {
  it("refuses an owner started inside a commit scope, not one that runs after it closed", async () => {
    const once = (run: () => Promise<unknown>) =>
      runBoundedAttempts({
        bound: 1,
        scope: (operation) => operation(),
        isMiss: () => false,
        run: (attempt) => attempt.commit(run),
        exhausted: () => undefined,
      });
    let later: Promise<unknown> | undefined;
    await expect(
      once(async () => {
        // Scheduled inside the scope, so it inherits its async context, but runs after it.
        later = new Promise((resolve) => setTimeout(resolve, 0)).then(() => once(async () => 1));
        return once(async () => 2);
      }),
    ).rejects.toBeInstanceOf(NestedAttemptError);
    await expect(later).resolves.toBe(1);
  });
});
