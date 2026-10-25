/**
 * The bounded-attempt owner (decision D13): a miss leaves its commit scope before the next
 * attempt captures anything (a retry never computes under the failed attempt's locks), and
 * every candidate a failed attempt owned is disposed, one whose own write succeeded inside
 * the rolled-back scope included. A second owner cannot start inside a commit scope (D16a).
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Draft attempt unwind and ownership transfer
 */
import { describe, expect, it } from "vitest";
import { type AttemptScope, NestedAttemptError, runBoundedAttempts } from "./draft-attempts.js";

class Miss extends Error {}

describe("runBoundedAttempts", () => {
  it("unwinds a missed attempt's scope and candidates before the next attempt captures", async () => {
    const events: string[] = [];
    const scope: AttemptScope = async (operation) => {
      events.push("scope open");
      try {
        return await operation();
      } finally {
        events.push("scope closed");
      }
    };
    const candidate = (name: string) => ({
      transfer: () => void events.push(`${name} transferred`),
      dispose: () => void events.push(`${name} disposed`),
    });
    let number = 0;
    const result = await runBoundedAttempts({
      bound: 4,
      scope,
      isMiss: (cause) => cause instanceof Miss,
      run: async (attempt) => {
        const current = ++number;
        events.push(`capture ${current}`);
        const first = attempt.own(candidate(`${current}a`));
        attempt.own(candidate(`${current}b`));
        await attempt.commit(async () => {
          events.push(`${current}a persisted`);
          if (current === 1) throw new Miss();
        });
        return first;
      },
      exhausted: () => {
        throw new Error("not exhausted");
      },
    });
    expect(events).toEqual([
      "capture 1",
      "scope open",
      "1a persisted",
      "scope closed",
      "1a disposed",
      "1b disposed",
      "capture 2",
      "scope open",
      "2a persisted",
      "scope closed",
      "2a transferred",
      "2b transferred",
    ]);
    expect(result).toBeDefined();
  });

  it("answers the last miss with the caller's policy and propagates anything else", async () => {
    const disposed: number[] = [];
    const run = (fail: () => Error) => {
      let number = 0;
      return runBoundedAttempts({
        bound: 2,
        scope: (operation) => operation(),
        isMiss: (cause) => cause instanceof Miss,
        run: async (attempt) => {
          const current = ++number;
          attempt.own({ transfer() {}, dispose: () => void disposed.push(current) });
          throw fail();
        },
        exhausted: (cause) => (cause instanceof Miss ? "stale" : "unreachable"),
      });
    };
    await expect(run(() => new Miss())).resolves.toBe("stale");
    expect(disposed).toEqual([1, 2]);
    await expect(run(() => new Error("broken"))).rejects.toThrow("broken");
    expect(disposed).toEqual([1, 2, 1]);
  });

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
