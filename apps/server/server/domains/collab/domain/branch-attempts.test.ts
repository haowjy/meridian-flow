/**
 * The bounded-attempt owner (decision D13): a miss leaves its commit scope before the next
 * attempt captures anything (a retry never computes under the failed attempt's locks), and
 * every candidate a failed attempt owned is disposed, one whose own write succeeded inside
 * the rolled-back scope included.
 */
import { describe, expect, it } from "vitest";
import { type AttemptScope, runBoundedAttempts } from "./branch-attempts.js";

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
    const result = await runBoundedAttempts({
      bound: 4,
      scope,
      isMiss: (cause) => cause instanceof Miss,
      run: async (attempt) => {
        events.push(`capture ${attempt.number}`);
        const first = attempt.own(candidate(`${attempt.number}a`));
        attempt.own(candidate(`${attempt.number}b`));
        await attempt.commit(async () => {
          events.push(`${attempt.number}a persisted`);
          if (attempt.number === 1) throw new Miss();
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
    const run = (fail: (attempt: number) => Error) =>
      runBoundedAttempts({
        bound: 2,
        scope: (operation) => operation(),
        isMiss: (cause) => cause instanceof Miss,
        run: async (attempt) => {
          attempt.own({ transfer() {}, dispose: () => void disposed.push(attempt.number) });
          throw fail(attempt.number);
        },
        exhausted: (cause) => (cause instanceof Miss ? "stale" : "unreachable"),
      });
    await expect(run(() => new Miss())).resolves.toBe("stale");
    expect(disposed).toEqual([1, 2]);
    await expect(run(() => new Error("broken"))).rejects.toThrow("broken");
    expect(disposed).toEqual([1, 2, 1]);
  });
});
