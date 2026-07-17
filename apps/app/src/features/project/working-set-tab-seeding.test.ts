import { describe, expect, it } from "vitest";

import { isWorkingSetRouteDesired } from "./working-set-tab-seeding";

describe("working-set tab seeding desired-state guard", () => {
  it("matches the full work-scoped route identity", () => {
    const route = { scheme: "scratch" as const, path: "/draft.md", workId: "work-1" };
    expect(isWorkingSetRouteDesired(route, [route])).toBe(true);
    expect(isWorkingSetRouteDesired(route, [{ ...route, workId: "work-2" }])).toBe(false);
    expect(isWorkingSetRouteDesired(route, [])).toBe(false);
  });
});
