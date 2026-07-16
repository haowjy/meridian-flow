// Behavioral coverage for body-complete concurrent run shaping.

import { describe, expect, it } from "vitest";
import { applyConcurrentRenderBudget } from "../concurrent-render-budget.js";
import type { BlockSnapshot } from "./echo.js";
import { DEFAULT_CONCURRENT_RUN_GAP, renderConcurrentRuns } from "./echo.js";

function blocks(count: number): BlockSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    hash: `h${index}`,
    clientID: 1,
    clock: index,
    renderedContent: `paragraph|block ${index}`,
    serialized: `h${index}|block ${index}`,
    lineage: [{ clientID: 1, clock: index, length: 1 }],
  }));
}

describe("concurrent run rendering", () => {
  it("renders a sparse changed block with one full anchor on each side", () => {
    const runs = renderConcurrentRuns({
      after: blocks(5),
      human: new Set(["h2"]),
      agent: new Set(),
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.blocks).toEqual(["h1|block 1", "h2|block 2", "h3|block 3"]);
    expect(runs[0]?.observations).toHaveLength(3);
  });

  it("repeatedly gap-merges nearby hunks and includes every gap block", () => {
    const runs = renderConcurrentRuns({
      after: blocks(12),
      human: new Set(["h2", "h6", "h10"]),
      agent: new Set(),
      gap: DEFAULT_CONCURRENT_RUN_GAP,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.blocks).toEqual(
      blocks(12)
        .slice(1)
        .map((block) => block.serialized),
    );
  });

  it("escalates rewrite-density runs to the whole flat sectionless document", () => {
    const after = blocks(5);
    const runs = renderConcurrentRuns({
      after,
      human: new Set(["h0", "h2", "h4"]),
      agent: new Set(),
    });

    expect(runs[0]?.blocks).toEqual(after.map((block) => block.serialized));
  });

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
