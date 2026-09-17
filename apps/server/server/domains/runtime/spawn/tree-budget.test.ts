/** Depth-3 default, operator env override, and the pre-create depth refusal. */
import { createDefaultTreeBudget, DEFAULT_MAX_SPAWN_DEPTH } from "@meridian/contracts/spawn";
import { describe, expect, it } from "vitest";
import { assertSpawnDepthAllowed, resolveMaxSpawnDepth } from "./tree-budget.js";

describe("tree budget depth", () => {
  it("defaults the spawn tree to depth 3", () => {
    expect(DEFAULT_MAX_SPAWN_DEPTH).toBe(3);
    expect(createDefaultTreeBudget().maxDepth).toBe(3);
    expect(createDefaultTreeBudget({ maxDepth: 5 }).maxDepth).toBe(5);
  });

  it("reads the operator env override, falling back to 3 when invalid or missing", () => {
    expect(resolveMaxSpawnDepth({ MERIDIAN_MAX_SPAWN_DEPTH: "4" })).toBe(4);
    expect(resolveMaxSpawnDepth({ MERIDIAN_MAX_SPAWN_DEPTH: "1" })).toBe(1);
    expect(resolveMaxSpawnDepth({ MERIDIAN_MAX_SPAWN_DEPTH: "0" })).toBe(3);
    expect(resolveMaxSpawnDepth({ MERIDIAN_MAX_SPAWN_DEPTH: "-2" })).toBe(3);
    expect(resolveMaxSpawnDepth({ MERIDIAN_MAX_SPAWN_DEPTH: "two" })).toBe(3);
    expect(resolveMaxSpawnDepth({ MERIDIAN_MAX_SPAWN_DEPTH: "" })).toBe(3);
    expect(resolveMaxSpawnDepth({})).toBe(3);
  });

  it("allows depth 3 and refuses depth 4 with a complete-directly message", () => {
    const budget = createDefaultTreeBudget();
    expect(assertSpawnDepthAllowed(budget, 2)).toBeNull();
    const refused = assertSpawnDepthAllowed(budget, 3);
    expect(refused?.code).toBe("spawn_depth_exceeded");
    expect(refused?.message).toContain("Complete the task directly");
  });
});
