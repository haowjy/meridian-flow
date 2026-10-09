// Behavioral coverage for body-complete concurrent run shaping.

import { describe, expect, it } from "vitest";
import { applyConcurrentRenderBudget } from "../concurrent-render-budget.js";
import type { BlockSnapshot } from "./echo.js";
import { renderConcurrentRuns } from "./echo.js";

function blocks(count: number): BlockSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    hash: `h${index}`,
    clientID: 1,
    clock: index,
    renderedContent: `paragraph|block ${index}`,
    body: `block ${index}`,
    serialized: `h${index}|block ${index}`,
    lineage: [{ clientID: 1, clock: index, length: 1 }],
  }));
}

describe("concurrent run rendering", () => {
  it("omits indivisible overflowing runs and exposes the typed marker", () => {
    const info = {
      human: ["h2"],
      agent: [],
      runs: renderConcurrentRuns({
        after: blocks(5),
        human: new Set(["h2"]),
        agent: new Set(),
      }),
    };

    const bounded = applyConcurrentRenderBudget(info, { remainingBytes: 1 });

    expect(bounded.runs).toEqual([]);
    expect(bounded.syncOverflow).toBe(true);
  });
});
