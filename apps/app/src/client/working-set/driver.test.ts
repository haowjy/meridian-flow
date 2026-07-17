import { describe, expect, it } from "vitest";

import { canSweepWorkingSet } from "./driver";

const pendingRecord = {
  snapshot: { recentRoutes: [], lastThreadId: null },
  pending: { baseRevision: null, localVersion: 1 },
};

describe("working-set sweep eligibility", () => {
  it("requires the real toggle, a pending report, and a session baseline", () => {
    expect(canSweepWorkingSet(true, true, pendingRecord)).toBe(true);
    expect(canSweepWorkingSet(false, true, pendingRecord)).toBe(false);
    expect(canSweepWorkingSet(true, false, pendingRecord)).toBe(false);
    expect(
      canSweepWorkingSet(true, true, {
        snapshot: pendingRecord.snapshot,
      }),
    ).toBe(false);
  });
});
