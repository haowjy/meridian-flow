import { describe, expect, it } from "vitest";
import { effectiveDbTestWorkerCount, parseDbTestWorkerCount } from "./db-test-workers";

describe("DB test worker count", () => {
  it("limits workers to the number of selected suites", () => {
    expect(effectiveDbTestWorkerCount(8, 1)).toBe(1);
    expect(effectiveDbTestWorkerCount(8, 3)).toBe(3);
    expect(effectiveDbTestWorkerCount(4, 20)).toBe(4);
  });

  it("rejects invalid configuration and an empty selection", () => {
    expect(() => parseDbTestWorkerCount("0")).toThrow("integer from 1 to 8");
    expect(() => parseDbTestWorkerCount("9")).toThrow("integer from 1 to 8");
    expect(() => effectiveDbTestWorkerCount(8, 0)).toThrow("selected no suites");
  });
});
