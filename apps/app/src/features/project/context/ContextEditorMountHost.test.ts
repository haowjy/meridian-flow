// @ts-nocheck
import { describe, expect, it } from "vitest";

import { pickMountedIds } from "./ContextEditorMountHost";

describe("pickMountedIds (mount LRU)", () => {
  it("always includes the active id", () => {
    const mounted = pickMountedIds([], ["a", "b", "c"], "b", 6);
    expect(mounted.has("b")).toBe(true);
  });

  it("returns empty when there are no tracked tabs", () => {
    expect(pickMountedIds(["a"], [], null, 6).size).toBe(0);
  });

  it("respects the cap and prefers recent over old", () => {
    const lru = ["d", "c", "b", "a"]; // d most recent
    const mounted = pickMountedIds(lru, ["a", "b", "c", "d"], "d", 2);
    expect([...mounted]).toEqual(["d", "c"]);
  });

  it("never includes an id that isn't in the tracked set", () => {
    const mounted = pickMountedIds(["ghost", "a"], ["a"], "a", 6);
    expect([...mounted]).toEqual(["a"]);
  });

  it("filling beyond cap evicts the LRU non-active id", () => {
    // Active is `a`; b/c/d are warm. cap=3 → mount a + 2 most recent of {b,c,d}.
    const lru = ["a", "d", "c", "b"];
    const mounted = pickMountedIds(lru, ["a", "b", "c", "d"], "a", 3);
    expect([...mounted]).toEqual(["a", "d", "c"]);
    expect(mounted.has("b")).toBe(false);
  });
});
