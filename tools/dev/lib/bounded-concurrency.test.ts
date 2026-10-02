import { describe, expect, it } from "vitest";
import { mapConcurrentSettled, throwSettledFailures } from "./bounded-concurrency";

describe("mapConcurrentSettled", () => {
  it("bounds concurrency and attempts every item after a failure", async () => {
    let active = 0;
    let peak = 0;
    const visited: number[] = [];
    const results = await mapConcurrentSettled([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      visited.push(value);
      if (value === 2) throw new Error("stuck");
      return value * 2;
    });

    expect(peak).toBe(2);
    expect(visited.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(() => throwSettledFailures("drop", results, ["one", "two"])).toThrow(
      "drop failed for 1 item(s): two (stuck)",
    );
  });
});
