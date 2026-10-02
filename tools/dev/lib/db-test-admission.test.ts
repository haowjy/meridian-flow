import { describe, expect, it } from "vitest";
import { budgetDbTestWorkers } from "./db-test-admission";

describe("budgetDbTestWorkers", () => {
  it("reserves live-development capacity and caps configured workers", () => {
    expect(budgetDbTestWorkers(8, 100, 5)).toBe(8);
    expect(budgetDbTestWorkers(8, 100, 38)).toBe(5);
    expect(budgetDbTestWorkers(4, 100, 5)).toBe(4);
  });

  it("reports no capacity instead of overcommitting Postgres", () => {
    expect(budgetDbTestWorkers(8, 100, 75)).toBe(0);
  });
});
