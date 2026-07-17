import { describe, expect, it } from "vitest";

import { shouldShowOptimisticContextRoute } from "./optimistic-context-route";

describe("optimistic context route", () => {
  it("holds the active place while its route is loading or awaiting tab materialization", () => {
    for (const resolution of ["loading", "found"] as const) {
      expect(
        shouldShowOptimisticContextRoute({
          hasDestination: true,
          hasActiveTab: false,
          resolution,
          autoOpenBlocked: false,
        }),
      ).toBe(true);
    }
  });

  it("falls back once a resolved tree proves the route is dead", () => {
    expect(
      shouldShowOptimisticContextRoute({
        hasDestination: true,
        hasActiveTab: false,
        resolution: "missing",
        autoOpenBlocked: false,
      }),
    ).toBe(false);
  });

  it("does not resurrect a deliberately closed route", () => {
    expect(
      shouldShowOptimisticContextRoute({
        hasDestination: true,
        hasActiveTab: false,
        resolution: "loading",
        autoOpenBlocked: true,
      }),
    ).toBe(false);
  });

  it("does not invent a destination for an empty desk", () => {
    expect(
      shouldShowOptimisticContextRoute({
        hasDestination: false,
        hasActiveTab: false,
        resolution: "loading",
        autoOpenBlocked: false,
      }),
    ).toBe(false);
  });
});
